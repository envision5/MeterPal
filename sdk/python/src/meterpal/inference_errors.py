"""The errors the inference client raises.

Each one carries the next action: a 402 knows how to open a PayPal
checkout, a 403 knows which model was refused.  The paywall is the point
of the product, so it gets first-class support rather than a raw HTTP
failure.

These are distinct from :class:`meterpal.MeterPalError` (the billing
client's error): the inference client talks to the metered gateway and its
failures are things the merchant's app acts on, not things the merchant's
billing code retries.
"""

from __future__ import annotations

from typing import Any, Callable, Dict, Optional


class MeterPalInferenceError(Exception):
    """Base class for inference-client failures.  Carries status + body."""

    def __init__(
        self,
        message: str = "MeterPal request failed",
        *,
        status: Optional[int] = None,
        code: Optional[str] = None,
        body: Any = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.body = body


class AuthenticationError(MeterPalInferenceError):
    """The MeterPal secret key was rejected."""

    def __init__(self, message: str = "Invalid MeterPal secret key", **kw: Any) -> None:
        super().__init__(message, **kw)


class InsufficientBalanceError(MeterPalInferenceError):
    """The end user cannot pay for this call.

    ``top_up()`` opens the PayPal checkout, so the caller does not have to
    know how MeterPal takes payments.
    """

    def __init__(
        self,
        message: str = "The customer does not have enough credits for this call",
        *,
        customer_id: Optional[str] = None,
        balance: Optional[float] = None,
        required_credits: Optional[float] = None,
        **kw: Any,
    ) -> None:
        super().__init__(message, **kw)
        self.customer_id = customer_id
        self.balance = balance
        self.required_credits = required_credits
        # Assigned by the client, which knows how to create a checkout for
        # this merchant.  Returns the checkout payload (url + id) to send
        # the end user to.
        self.top_up: Optional[Callable[..., Dict[str, Any]]] = None


class ModelNotEnabledError(MeterPalInferenceError):
    """The merchant does not serve this model."""

    def __init__(
        self,
        message: str = "This model is not enabled for this organization",
        *,
        model: Optional[str] = None,
        **kw: Any,
    ) -> None:
        super().__init__(message, **kw)
        self.model = model


class ModelNotFoundError(MeterPalInferenceError):
    """The merchant has never heard of this model."""

    def __init__(
        self,
        message: str = "This model is not in the organization's served catalog",
        *,
        model: Optional[str] = None,
        **kw: Any,
    ) -> None:
        super().__init__(message, **kw)
        self.model = model


class RateLimitError(MeterPalInferenceError):
    """The end user's plan limit was reached."""

    def __init__(self, message: str = "Rate limit exceeded", **kw: Any) -> None:
        super().__init__(message, **kw)


class CustomerNotFoundError(MeterPalInferenceError):
    """The end user does not exist in this organization."""

    def __init__(
        self,
        message: str = "No such customer in this organization",
        *,
        customer_id: Optional[str] = None,
        **kw: Any,
    ) -> None:
        super().__init__(message, **kw)
        self.customer_id = customer_id


class APIError(MeterPalInferenceError):
    """The API answered with something the client cannot use."""

    def __init__(self, message: str = "MeterPal request failed", **kw: Any) -> None:
        super().__init__(message, **kw)


class ConnectionError(MeterPalInferenceError):
    """The API could not be reached."""

    def __init__(self, message: str = "Could not reach MeterPal", **kw: Any) -> None:
        super().__init__(message, **kw)
