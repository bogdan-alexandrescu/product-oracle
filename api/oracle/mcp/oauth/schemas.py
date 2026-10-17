"""Wire formats. Field names follow the RFCs (8414, 9728, 7591, 6749), not house style."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from oracle.auth.models import Role


class ProtectedResourceMetadata(BaseModel):
    resource: str
    authorization_servers: list[str]
    scopes_supported: list[str]
    bearer_methods_supported: list[str]
    resource_name: str


class AuthorizationServerMetadata(BaseModel):
    issuer: str
    authorization_endpoint: str
    token_endpoint: str
    registration_endpoint: str
    revocation_endpoint: str
    scopes_supported: list[str]
    response_types_supported: list[str]
    response_modes_supported: list[str]
    grant_types_supported: list[str]
    code_challenge_methods_supported: list[str]
    token_endpoint_auth_methods_supported: list[str]
    revocation_endpoint_auth_methods_supported: list[str]
    authorization_response_iss_parameter_supported: bool


class ClientRegistrationIn(BaseModel):
    # Other RFC 7591 metadata (logo_uri, client_uri, software_id, ...) is ignored.
    model_config = ConfigDict(extra="ignore")

    redirect_uris: list[str] | None = None
    client_name: str | None = None
    token_endpoint_auth_method: str | None = None
    grant_types: list[str] | None = None
    response_types: list[str] | None = None
    scope: str | None = None


class ClientRegistrationOut(BaseModel):
    client_id: str
    client_id_issued_at: int
    client_name: str
    redirect_uris: list[str]
    grant_types: list[str]
    response_types: list[str]
    token_endpoint_auth_method: Literal["none"]
    scope: str


class OAuthErrorOut(BaseModel):
    error: str
    error_description: str | None = None


class ScopeOut(BaseModel):
    name: str
    description: str


class ConsentRequestOut(BaseModel):
    """What the consent screen shows for a pending authorization request."""

    client_id: str
    client_name: str
    redirect_uri: str
    # The host the browser returns to after the decision, shown so a user can spot a
    # client whose self-declared name does not match where it sends them.
    redirect_host: str
    scopes: list[ScopeOut]
    user_email: str
    user_role: Role
    # What a token from this grant can do: the role intersected with the scopes.
    effective_role: Role


class ConsentDecisionIn(BaseModel):
    request: str = Field(description="The signed request handle from the consent URL")
    approve: bool


class ConsentDecisionOut(BaseModel):
    """Where the browser goes next: the client's redirect URI with a code or an error."""

    redirect_to: str


class TokenOut(BaseModel):
    access_token: str
    token_type: Literal["Bearer"]
    expires_in: int
    refresh_token: str
    scope: str
