"""The MeterPal inference client.

An OpenAI-shaped client that bills the end user for every call:

    from meterpal import create_meterpal

    meterpal = create_meterpal(api_key="am_sk_test_...")   # server-side only

    completion = meterpal.chat.completions.create(
        model="custom/demo-gpt",
        messages=[{"role": "user", "content": "hi"}],
        user="cus_123",          # the end user being billed
    )

    completion["meterpal"]["credits_charged"]   # what it cost

The secret key stays on the server.  The client mints a per-customer
virtual key on first use and caches it, so the merchant's app never has to
think about credentials again.

This is the Python half of the "one import" promise (docs/architecture.md
§4.4): swap ``from openai import OpenAI`` for ``from meterpal import
create_meterpal`` and every call is admitted, metered and charged.  The
TypeScript half lives in ``sdk/typescript/src/inference/``.
"""

from __future__ import annotations

import json
from typing import Any, Dict, Generator, Iterator, Optional

import httpx

from .inference_errors import (
    APIError,
    AuthenticationError,
    ConnectionError,
    CustomerNotFoundError,
    InsufficientBalanceError,
    MeterPalInferenceError,
    ModelNotEnabledError,
    ModelNotFoundError,
    RateLimitError,
)

DEFAULT_API_BASE_URL = "https://api.meterpal.dev"

VIRTUAL_KEY_PREFIX = "sk-"

#: The virtual keys this process has minted.
#:
#: Module-level on purpose: an app that builds a client per request (the
#: usual web-handler shape) should still mint one key per end user, not one
#: per request.
_virtual_key_cache: Dict[str, str] = {}


def _cache_key(base_url: str, api_key: str, customer_id: str) -> str:
    return f"{base_url}|{api_key}|{customer_id}"


class _ChatCompletions:
    def __init__(self, client: "MeterPalInference") -> None:
        self._client = client

    def create(self, **params: Any) -> Dict[str, Any]:
        """Run one completion and bill the end user."""
        return self._client._create_completion(params)

    def stream(self, **params: Any) -> Generator[Dict[str, Any], None, None]:
        """Run one completion as a stream of chunks."""
        return self._client._stream_completion(params)


class _Chat:
    def __init__(self, client: "MeterPalInference") -> None:
        self.completions = _ChatCompletions(client)


class _Keys:
    def __init__(self, client: "MeterPalInference") -> None:
        self._client = client

    def provision(self, customer_id: str) -> Dict[str, Any]:
        """Mint (or fetch) the gateway credential for one end user."""
        return self._client._provision_key(customer_id)


class _Models:
    def __init__(self, client: "MeterPalInference") -> None:
        self._client = client

    def list(self) -> Dict[str, Any]:
        """The models this merchant serves, with their prices."""
        return self._client._catalog()


class MeterPalInference:
    """The shape the merchant's app holds onto: ``meterpal.chat.completions``."""

    def __init__(
        self,
        api_key: str,
        base_url: str = DEFAULT_API_BASE_URL,
        *,
        timeout: float = 120.0,
        transport: Optional[httpx.BaseTransport] = None,
        auto_create_customer: bool = True,
        headers: Optional[Dict[str, str]] = None,
    ) -> None:
        if not api_key:
            raise ValueError(
                "create_meterpal needs an api_key -- the merchant's MeterPal secret key."
            )
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._auto_create_customer = auto_create_customer
        self._extra_headers = headers or {}
        self._is_virtual_key = api_key.startswith(VIRTUAL_KEY_PREFIX)
        self._client = httpx.Client(
            base_url=self._base_url,
            timeout=timeout,
            transport=transport,
        )
        self.chat = _Chat(self)
        self.keys = _Keys(self)
        self.models = _Models(self)

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "MeterPalInference":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    # -------- internals --------

    def _request(
        self,
        method: str,
        path: str,
        json_body: Any = None,
        credential: str = "",
        accept: Optional[str] = None,
    ) -> httpx.Response:
        headers = {
            "Authorization": f"Bearer {credential}",
            "Content-Type": "application/json",
            **self._extra_headers,
        }
        if accept:
            headers["Accept"] = accept
        try:
            return self._client.request(
                method, path, json=json_body, headers=headers
            )
        except httpx.TimeoutException as exc:
            raise ConnectionError(
                f"MeterPal request timed out after {self._timeout}s"
            ) from exc
        except httpx.HTTPError as exc:
            raise ConnectionError(f"Could not reach MeterPal at {self._base_url}") from exc

    @staticmethod
    def _read_json(response: httpx.Response) -> Any:
        text = response.text
        if not text:
            return None
        try:
            return json.loads(text)
        except ValueError:
            return {"message": text}

    def _provision_key(self, customer_id: str) -> Dict[str, Any]:
        response = self._request(
            "POST",
            "/v1/keys",
            json_body={"customer_id": customer_id},
            credential=self._api_key,
        )
        data = self._read_json(response)
        if not response.is_success:
            raise self._to_error(response.status_code, data)
        if isinstance(data, dict) and data.get("key"):
            _virtual_key_cache[
                _cache_key(self._base_url, self._api_key, customer_id)
            ] = data["key"]
        return data

    def _create_customer(self, customer_id: str) -> None:
        """Create the end user, so the merchant never has to.

        The billing server's get-or-create contract keys the body on ``id``
        (handleGetOrCreateCustomer reads createCusParams.id).
        """
        response = self._request(
            "POST",
            "/v1/customers",
            json_body={"id": customer_id},
            credential=self._api_key,
        )
        data = self._read_json(response)
        if not response.is_success:
            raise self._to_error(response.status_code, data)

    def _create_checkout(
        self,
        customer_id: str,
        product_id: Optional[str] = None,
        return_url: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Open a PayPal checkout for the end user."""
        body: Dict[str, Any] = {"customer_id": customer_id}
        if product_id:
            body["product_id"] = product_id
        if return_url:
            body["success_url"] = return_url
        response = self._request(
            "POST", "/v1/checkout", json_body=body, credential=self._api_key
        )
        data = self._read_json(response)
        if not response.is_success:
            raise self._to_error(response.status_code, data)
        url = None
        if isinstance(data, dict):
            url = (
                data.get("paymentUrl")
                or data.get("payment_url")
                or data.get("checkout_url")
                or data.get("url")
            )
        if not url:
            raise APIError("MeterPal did not return a checkout URL")
        checkout_id = None
        if isinstance(data, dict):
            checkout_id = data.get("id") or data.get("checkout_id")
        return {"url": url, "id": checkout_id}

    def _catalog(self) -> Dict[str, Any]:
        response = self._request("GET", "/v1/catalog", credential=self._api_key)
        data = self._read_json(response)
        if not response.is_success:
            raise self._to_error(response.status_code, data)
        return data

    def _resolve_credential(self, customer_id: str) -> str:
        """The credential to bill this end user with.

        A merchant secret key is exchanged for a per-customer virtual key on
        first use; the gateway only ever sees per-customer keys, so one
        merchant's traffic can never spend another merchant's budget.

        Minting the key is also the first moment we learn the end user does
        not exist, so that is where they get created.
        """
        if self._is_virtual_key:
            return self._api_key

        cached = _virtual_key_cache.get(
            _cache_key(self._base_url, self._api_key, customer_id)
        )
        if cached:
            return cached

        response = self._request(
            "POST",
            "/v1/keys",
            json_body={"customer_id": customer_id},
            credential=self._api_key,
        )
        data = self._read_json(response)

        if not response.is_success:
            # Minting a key can only fail with 404 when the end user does
            # not exist, so that is where they get created: the merchant's
            # app needs no setup step before their users can chat.
            if response.status_code == 404 and self._auto_create_customer:
                self._create_customer(customer_id)
                response = self._request(
                    "POST",
                    "/v1/keys",
                    json_body={"customer_id": customer_id},
                    credential=self._api_key,
                )
                data = self._read_json(response)
                if not response.is_success:
                    raise self._to_error(response.status_code, data)
            else:
                raise self._to_error(response.status_code, data)

        key = data.get("key") if isinstance(data, dict) else None
        if not key:
            raise APIError("MeterPal did not return an inference key")
        _virtual_key_cache[_cache_key(self._base_url, self._api_key, customer_id)] = key
        return key

    @staticmethod
    def _require_user(params: Dict[str, Any]) -> str:
        user = params.get("user")
        if not user or not isinstance(user, str):
            raise MeterPalInferenceError(
                "`user` is required -- it is the id of the end user being billed."
            )
        return user

    @staticmethod
    def _body_error_code(data: Any) -> Optional[str]:
        if not isinstance(data, dict):
            return None
        error = data.get("error")
        if isinstance(error, dict) and error.get("code"):
            return error["code"]
        return data.get("code")

    def _to_error(self, status: int, body: Any) -> MeterPalInferenceError:
        """Turn an API answer into the error the caller can act on.

        The code decides when the status is ambiguous (404 is either an
        unknown model or an unknown end user); the status decides otherwise.
        """
        error: Dict[str, Any] = {}
        if isinstance(body, dict) and isinstance(body.get("error"), dict):
            error = body["error"]
        code = self._body_error_code(body)
        message = (
            (error.get("message") if isinstance(error, dict) else None)
            or (body.get("message") if isinstance(body, dict) else None)
            or f"MeterPal request failed ({status})"
        )
        options = {"status": status, "code": code, "body": body}

        if code == "model_not_enabled":
            return ModelNotEnabledError(message, **options)
        if code == "model_not_found":
            return ModelNotFoundError(message, **options)
        if code == "customer_not_found":
            return CustomerNotFoundError(
                message,
                customer_id=error.get("customer_id") if isinstance(error, dict) else None,
                **options,
            )

        if status == 401:
            return AuthenticationError(message, **options)
        if status == 402:
            return InsufficientBalanceError(
                message,
                customer_id=error.get("customer_id") if isinstance(error, dict) else None,
                balance=error.get("balance") if isinstance(error, dict) else None,
                required_credits=(
                    error.get("required_credits") if isinstance(error, dict) else None
                ),
                **options,
            )
        if status == 403:
            return ModelNotEnabledError(message, **options)
        if status == 404:
            return ModelNotFoundError(message, **options)
        if status == 429:
            return RateLimitError(message, **options)
        return APIError(message, **options)

    def _decorate(
        self, error: MeterPalInferenceError, customer_id: str
    ) -> MeterPalInferenceError:
        """Give the paywall its way out: the checkout it can open."""
        if isinstance(error, InsufficientBalanceError):
            error.customer_id = error.customer_id or customer_id
            error.top_up = self._make_top_up(error.customer_id or customer_id)
        return error

    def _make_top_up(self, customer_id: str):
        def top_up(
            product_id: Optional[str] = None,
            return_url: Optional[str] = None,
        ) -> Dict[str, Any]:
            return self._create_checkout(
                customer_id, product_id=product_id, return_url=return_url
            )

        return top_up

    # -------- inference --------

    def _create_completion(self, params: Dict[str, Any]) -> Dict[str, Any]:
        customer_id = self._require_user(params)
        credential = self._resolve_credential(customer_id)

        response = self._request(
            "POST",
            "/v1/chat/completions",
            json_body={**params, "user": customer_id},
            credential=credential,
        )
        data = self._read_json(response)

        # The end user does not exist yet: create them and try again, so the
        # merchant's app needs no setup step.
        if (
            not response.is_success
            and response.status_code == 404
            and self._body_error_code(data) == "customer_not_found"
            and self._auto_create_customer
        ):
            self._create_customer(customer_id)
            _virtual_key_cache.pop(
                _cache_key(self._base_url, self._api_key, customer_id), None
            )
            credential = self._resolve_credential(customer_id)
            response = self._request(
                "POST",
                "/v1/chat/completions",
                json_body={**params, "user": customer_id},
                credential=credential,
            )
            data = self._read_json(response)

        if not response.is_success:
            raise self._decorate(self._to_error(response.status_code, data), customer_id)
        return data

    def _stream_completion(
        self, params: Dict[str, Any]
    ) -> Generator[Dict[str, Any], None, None]:
        customer_id = self._require_user(params)
        credential = self._resolve_credential(customer_id)

        headers = {
            "Authorization": f"Bearer {credential}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
            **self._extra_headers,
        }
        try:
            with self._client.stream(
                "POST",
                "/v1/chat/completions",
                json={**params, "user": customer_id, "stream": True},
                headers=headers,
            ) as response:
                if not response.is_success:
                    data = self._read_json(response)
                    raise self._decorate(
                        self._to_error(response.status_code, data), customer_id
                    )
                for payload in self._read_sse(response.iter_lines()):
                    yield payload
        except httpx.TimeoutException as exc:
            raise ConnectionError(
                f"MeterPal request timed out after {self._timeout}s"
            ) from exc
        except httpx.HTTPError as exc:
            raise ConnectionError(f"Could not reach MeterPal at {self._base_url}") from exc

    @staticmethod
    def _read_sse(lines: Iterator[str]) -> Generator[Dict[str, Any], None, None]:
        """Read a Server-Sent Events stream.

        Yields every ``data:`` payload except the ``[DONE]`` terminator.  The
        final payload MeterPal sends is the charge for the call, which
        arrives as ``{"meterpal": {...}}``.
        """
        data_lines: list[str] = []
        for raw in lines:
            line = raw.rstrip("\r\n")
            if line == "":
                if data_lines:
                    payload = "\n".join(data_lines)
                    data_lines = []
                    if payload == "[DONE]":
                        return
                    try:
                        yield json.loads(payload)
                    except ValueError:
                        continue
                continue
            if line.startswith("data:"):
                data_lines.append(line[len("data:"):].strip())
        # A stream that ends without a blank line still owes its last event.
        if data_lines:
            payload = "\n".join(data_lines)
            if payload != "[DONE]":
                try:
                    yield json.loads(payload)
                except ValueError:
                    pass


def create_meterpal(
    api_key: str,
    base_url: str = DEFAULT_API_BASE_URL,
    *,
    timeout: float = 120.0,
    transport: Optional[httpx.BaseTransport] = None,
    auto_create_customer: bool = True,
    headers: Optional[Dict[str, str]] = None,
) -> MeterPalInference:
    """Build an OpenAI-shaped client that bills the end user for every call.

    ``api_key`` is the merchant's MeterPal secret key (server-side only), or
    a per-customer virtual key (``sk-...``) to bill one specific end user.
    """
    return MeterPalInference(
        api_key,
        base_url,
        timeout=timeout,
        transport=transport,
        auto_create_customer=auto_create_customer,
        headers=headers,
    )
