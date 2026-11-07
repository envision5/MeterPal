"""MeterPal — PayPal-native AI usage billing SDK (Python).

Two surfaces:

- :class:`MeterPalClient` — the billing client (customers, balances, check,
  track_tokens, checkout).
- :func:`create_meterpal` — the OpenAI-shaped inference client: swap one
  import and every call is admitted, metered and charged to the end user.
"""

from .client import DEFAULT_BASE_URL, MeterPalClient, MeterPalError
from .inference import DEFAULT_API_BASE_URL, MeterPalInference, create_meterpal
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

__all__ = [
    "DEFAULT_BASE_URL",
    "MeterPalClient",
    "MeterPalError",
    "DEFAULT_API_BASE_URL",
    "MeterPalInference",
    "create_meterpal",
    "MeterPalInferenceError",
    "InsufficientBalanceError",
    "APIError",
    "AuthenticationError",
    "ConnectionError",
    "CustomerNotFoundError",
    "ModelNotEnabledError",
    "ModelNotFoundError",
    "RateLimitError",
]
__version__ = "0.1.0"
