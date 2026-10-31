"""O5 lane 4: company branding (spec-O5 section 4).

The ``branding`` company setting (``oracle.tenant_settings_api.DEFAULTS``) holds the
display name, the logo and its dark variant (by sha256), the accent, the public disclaimer,
the "Made with Product Oracle" switch for shared pages (O5-Q8) and a revision that bumps on
every change (the render caches' key). Every member reads it; owners change it, here only
(``PUT /v1/settings/branding`` refuses, so the revision and the logos stay in step).

Logos live in ``brand_assets``: PNG, JPEG or WebP, at most :data:`MAX_LOGO_BYTES` and
:data:`MAX_LOGO_SIDE` px a side, decoded and re-encoded to PNG with Pillow (metadata
stripped, decompression bombs refused). SVG is refused: it can carry script. Members read a
logo at ``/uploads/brand/<sha256>.png``, as ``image/png`` with ``nosniff`` and a CSP that
runs nothing. Exports, decks, PPTX and shared pages inline it as a ``data:`` image from the
header partial (:func:`render_brand_header`), the one data image the renderer allows.

Which logo (owner decision, 2026-10-26): the dark one when the theme's background is dark
(WCAG relative luminance below :data:`DARK_LUMINANCE`, :func:`dark_background`), the light
one otherwise, and the light one everywhere while no dark logo is uploaded
(:meth:`Brand.uses_dark`). Exports, decks, PPTX and publications all choose so, and the
Branding preview lists the choice for each built-in theme (``theme_logos``).
"""

import base64
import copy
import hashlib
import io
import re
import uuid
import warnings
from dataclasses import dataclass
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, File, HTTPException, Query, Response, UploadFile, status
from markupsafe import Markup, escape
from pydantic import BaseModel
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.auth.deps import Principal, TenantDB
from oracle.authz import has_role, not_for_runs, recheck_caller, require_role
from oracle.branding_models import BrandAsset
from oracle.tenancy import current_tenant

__all__ = [
    "BrandAsset",
    "Brand",
    "dark_background",
    "load_brand",
    "render_brand_header",
    "router",
]

MAX_LOGO_BYTES = 512 * 1024
MAX_LOGO_SIDE = 2000
MAX_NAME = 80
MAX_DISCLAIMER = 500
LOGO_FORMATS = {"PNG", "JPEG", "WEBP"}
NOT_AN_IMAGE = "Upload a PNG, JPEG or WebP"
TOO_BIG = "The logo must be at most 512 KB"
TOO_LARGE = "The logo must be at most 2,000 × 2,000 px"
# A background below this relative luminance (WCAG) is dark: the dark logo goes on it.
DARK_LUMINANCE = 0.5
TOO_LIGHT = "This colour is too light to read on white. Pick a darker one."
DEFAULT_DISCLAIMER = (
    "This roadmap shows our current plans. It is not a commitment, and plans and timing can change."
)
MARK = "Made with Product Oracle"
STAND_IN = "“Example Co” is a stand-in name. Type your company's name."
# The setting's stored shape; display_name null reads as the company's name.
DEFAULT: dict[str, Any] = {
    "display_name": None,
    "logo": None,
    "logo_dark": None,
    "accent": None,
    "public_disclaimer": DEFAULT_DISCLAIMER,
    "oracle_mark": True,
    "revision": 0,
}
SETTING = "branding"
_HEX = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")
_SHA = re.compile(r"^[0-9a-f]{64}$")
# Served logos: nothing in them may run, nor be read as another type.
LOGO_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cache-Control": "private, max-age=86400, immutable",
    "Content-Disposition": "inline",
}


class InvalidLogo(ValueError):
    pass


def reencode_logo(data: bytes) -> tuple[bytes, int, int]:
    """``data`` as a metadata-free PNG with its size; :class:`InvalidLogo` for anything
    but a PNG, JPEG or WebP within the limits."""
    from PIL import Image

    if len(data) > MAX_LOGO_BYTES:
        raise InvalidLogo(TOO_BIG)
    if not data:
        raise InvalidLogo(NOT_AN_IMAGE)
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            img = Image.open(io.BytesIO(data), formats=sorted(LOGO_FORMATS))
            if img.width > MAX_LOGO_SIDE or img.height > MAX_LOGO_SIDE:
                raise InvalidLogo(TOO_LARGE)
            img.load()
            if img.mode not in ("RGB", "RGBA", "L", "LA"):
                alpha = "A" in img.getbands() or "transparency" in img.info
                img = img.convert("RGBA" if alpha else "RGB")
            out = io.BytesIO()
            img.save(out, format="PNG", optimize=True)
    except InvalidLogo:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise InvalidLogo(TOO_LARGE) from None
    except Exception:  # noqa: BLE001 - any decoder failure is "not an image we take"
        raise InvalidLogo(NOT_AN_IMAGE) from None
    return out.getvalue(), img.width, img.height


def check_accent(value: Any) -> str | None:
    """A hex accent readable on every built-in theme's background (WCAG AA), or None."""
    from oracle.templates.builtins import BUILTIN_THEMES
    from oracle.templates.validation import AA_BODY, contrast

    if value is None:
        return None
    if not isinstance(value, str) or not _HEX.match(value):
        raise ValueError("The accent must be a hex colour like #0369a1")
    for theme in BUILTIN_THEMES:
        background = (theme.tokens.get("colors") or {}).get("background") or "#ffffff"
        if contrast(value, background) < AA_BODY:
            raise ValueError(TOO_LIGHT)
    if len(value) == 4:  # "#rgb" is stored as "#rrggbb"
        value = "#" + "".join(c * 2 for c in value[1:])
    return value.lower()


def dark_background(colour: Any) -> bool:
    """Whether a hex ``colour`` is a dark background (relative luminance below
    :data:`DARK_LUMINANCE`); no colour, or not a hex one, is the page's white."""
    from oracle.templates.validation import luminance

    if not isinstance(colour, str) or not _HEX.match(colour):
        return False
    return luminance(colour) < DARK_LUMINANCE


def theme_background(tokens: dict | None) -> str | None:
    """A theme's page background (its tokens' ``colors.background``), if it sets one."""
    return ((tokens or {}).get("colors") or {}).get("background")


async def stored(db: AsyncSession) -> dict[str, Any]:
    from oracle.tenant_settings_api import get_setting

    return {**copy.deepcopy(DEFAULT), **(await get_setting(db, SETTING) or {})}


async def _save(db: AsyncSession, principal: Principal, value: dict[str, Any], action: str) -> None:
    from oracle.tenant_settings import TenantSetting

    value = {**value, "revision": int(value.get("revision") or 0) + 1}
    row = await db.scalar(select(TenantSetting).where(TenantSetting.key == SETTING))
    if row is None:
        db.add(TenantSetting(key=SETTING, value=value, updated_by=principal.id))
    else:
        row.value = value
        row.updated_by = principal.id
    data = {k: v for k, v in value.items() if k not in ("logo", "logo_dark")}
    data["logo"] = (value.get("logo") or {}).get("sha256")
    data["logo_dark"] = (value.get("logo_dark") or {}).get("sha256")
    await audit.record(db, principal, action, "tenant_setting", data={"key": SETTING, **data})


async def _drop_unused(db: AsyncSession, value: dict[str, Any]) -> None:
    """Logos neither variant names any more are deleted (no URL serves them after)."""
    keep = [(value.get(k) or {}).get("sha256") for k in ("logo", "logo_dark")]
    await db.execute(delete(BrandAsset).where(BrandAsset.sha256.not_in([k for k in keep if k])))


async def reset(db: AsyncSession, principal: Principal, previous: Any) -> None:
    """The generic reset (``PUT /v1/settings/branding`` with a null value): every default
    back, the revision still counting up (render caches never see an old number again) and
    every stored logo deleted (no URL serves one after)."""
    from oracle.tenant_settings import TenantSetting

    revision = int((previous or {}).get("revision") or 0) + 1
    value = {**copy.deepcopy(DEFAULT), "revision": revision}
    row = await db.scalar(select(TenantSetting).where(TenantSetting.key == SETTING))
    if row is None:
        db.add(TenantSetting(key=SETTING, value=value, updated_by=principal.id))
    else:
        row.value = value
        row.updated_by = principal.id
    await db.execute(delete(BrandAsset))


async def company_name(db: AsyncSession) -> str:
    from oracle.models import Tenant

    tenant = await db.get(Tenant, current_tenant(db))
    return tenant.name if tenant is not None else ""


async def export_name(db: AsyncSession) -> str:
    """The name an export prints when branding names none: the company's, never the
    seed's placeholder (e2e-pdf-export, 2026-10-30: "" prints no name)."""
    return _not_placeholder(await company_name(db))


def _not_placeholder(name: Any) -> str:
    """``name``, or "" when it is none or the seed's placeholder (e2e-pdf-export review)."""
    from oracle.models import PLACEHOLDER_NAME

    name = name.strip() if isinstance(name, str) else ""
    return "" if name == PLACEHOLDER_NAME else name


async def brand_name(db: AsyncSession, value: dict[str, Any]) -> str:
    """The display name the branding ``value`` stores, else the company's; never the
    seed's placeholder."""
    return _not_placeholder(value.get("display_name")) or await export_name(db)


# --- what renders read ------------------------------------------------------------------


@dataclass(frozen=True)
class Brand:
    """The company's branding as a render reads it: plain values, no session."""

    tenant_id: uuid.UUID
    display_name: str
    accent: str | None
    public_disclaimer: str
    oracle_mark: bool
    revision: int
    logo_png: bytes | None = None
    logo_size: tuple[int, int] | None = None
    logo_dark_png: bytes | None = None
    logo_dark_size: tuple[int, int] | None = None

    def uses_dark(self, background: Any) -> bool:
        """Whether a page on ``background`` shows the dark logo: the background is dark
        and a dark logo is uploaded (without one the light logo is used everywhere)."""
        return self.logo_dark_png is not None and dark_background(background)

    def logo_for(self, dark: bool) -> tuple[bytes | None, tuple[int, int] | None]:
        """The PNG and its size a page shows (``dark``: :meth:`uses_dark`)."""
        if dark and self.logo_dark_png is not None:
            return self.logo_dark_png, self.logo_dark_size
        return self.logo_png, self.logo_size

    @property
    def logo_data_uri(self) -> str | None:
        return _data_uri(self.logo_png)

    @property
    def logo_dark_data_uri(self) -> str | None:
        return _data_uri(self.logo_dark_png or self.logo_png)

    @property
    def key(self) -> tuple:
        """What a kept render of this brand depends on: everything it shows."""
        digest = hashlib.sha256()
        for part in (self.logo_png, self.logo_dark_png):
            digest.update(hashlib.sha256(part or b"").digest())
        return (
            self.tenant_id,
            self.display_name,
            self.accent,
            self.public_disclaimer,
            self.oracle_mark,
            digest.hexdigest(),
        )

    def apply_accent(self, tokens: dict | None) -> dict:
        """Theme tokens with the brand's accent in place of the theme's."""
        tokens = dict(tokens or {})
        if self.accent:
            tokens["colors"] = {**(tokens.get("colors") or {}), "accent": self.accent}
        return tokens


def _data_uri(png: bytes | None) -> str | None:
    return "data:image/png;base64," + base64.b64encode(png).decode() if png else None


async def load_brand(db: AsyncSession) -> Brand:
    value = await stored(db)
    shas = [(value.get(k) or {}).get("sha256") for k in ("logo", "logo_dark")]
    assets = {
        a.sha256: a
        for a in (
            await db.scalars(
                select(BrandAsset).where(BrandAsset.sha256.in_([s for s in shas if s]))
            )
        ).all()
    }
    light, dark = (assets.get(s) if s else None for s in shas)
    accent = value.get("accent")
    return Brand(
        tenant_id=current_tenant(db),
        display_name=await brand_name(db, value),
        accent=accent if isinstance(accent, str) and _HEX.match(accent) else None,
        public_disclaimer=value.get("public_disclaimer") or DEFAULT_DISCLAIMER,
        oracle_mark=bool(value.get("oracle_mark", True)),
        revision=int(value.get("revision") or 0),
        logo_png=light.bytes if light else None,
        logo_size=(light.width, light.height) if light else None,
        logo_dark_png=dark.bytes if dark else None,
        logo_dark_size=(dark.width, dark.height) if dark else None,
    )


def accent_css(brand: "Brand | None") -> Markup:
    """The brand's accent over every stylesheet's accent variable ('' without one)."""
    if brand is None or not brand.accent:
        return Markup("")
    a = brand.accent  # validated hex
    return Markup(
        f":root, .deck {{ --color-accent: {a}; --accent: {a}; }}\n"
        f".brand-header {{ border-bottom-color: {a}; }}"
    )


BRAND_CSS = """
.brand-header { display: flex; flex-basis: 100%; align-items: center; gap: 12px;
  padding: 0 0 8px; margin: 0 0 8px;
  border-bottom: 2px solid var(--color-accent, var(--accent, #2f5bd3)); }
.brand-header .brand-logo { max-height: 40px; height: auto; width: auto; }
.brand-header .brand-name { font-weight: 600; font-size: 1rem; }
.brand-header .brand-mark { margin-left: auto; font-size: 0.75rem; opacity: 0.7; }
.slide .brand-logo { max-height: 40px; width: auto; display: block; margin-bottom: 18px; }
"""


def render_brand_header(
    brand: "Brand | None", *, shared: bool = False, dark: bool = False
) -> Markup:
    """The header partial, first in a page's header: the logo (at most 40 px high) or
    the company's name; on a shared page (``shared``) also Oracle's small mark unless an
    owner switched it off (O5-Q8; never on exports)."""
    if brand is None:
        return Markup("")
    uri = brand.logo_dark_data_uri if dark else brand.logo_data_uri
    name = escape(brand.display_name)
    if not uri and not name and not (shared and brand.oracle_mark):
        return Markup("")
    parts = ['<div class="brand-header">']
    if uri:
        parts.append(f'<img class="brand-logo" src="{uri}" alt="{name}" height="40">')
    if name:
        parts.append(f'<span class="brand-name">{name}</span>')
    if shared and brand.oracle_mark:
        parts.append(f'<span class="brand-mark">{MARK}</span>')
    parts.append("</div>")
    return Markup("".join(parts))


def render_brand_logo(brand: "Brand | None", *, dark: bool = False) -> Markup:
    """The logo alone (a deck's title slide); '' without one."""
    if brand is None:
        return Markup("")
    uri = brand.logo_dark_data_uri if dark else brand.logo_data_uri
    if not uri:
        return Markup("")
    return Markup(f'<img class="brand-logo" src="{uri}" alt="{escape(brand.display_name)}">')


# --- routes -----------------------------------------------------------------------------

router = APIRouter(tags=["branding"])
Viewer = Annotated[Principal, Depends(require_role("viewer"))]
Owner = Annotated[Principal, Depends(require_role("owner"))]
Variant = Literal["light", "dark"]


class BrandLogo(BaseModel):
    sha256: str
    type: str
    width: int
    height: int
    url: str


class ThemeLogo(BaseModel):
    """Which logo a built-in theme's exports and decks use."""

    key: str
    name: str
    background: str
    variant: Variant


class BrandingOut(BaseModel):
    display_name: str
    logo: BrandLogo | None
    logo_dark: BrandLogo | None
    accent: str | None
    public_disclaimer: str
    oracle_mark: bool
    revision: int
    can_edit: bool
    theme_logos: list[ThemeLogo] = []
    updated_at: datetime | None = None


class BrandingIn(BaseModel):
    display_name: str
    accent: str | None = None
    public_disclaimer: str
    oracle_mark: bool = True


def _logo(value: Any) -> BrandLogo | None:
    if not isinstance(value, dict) or not value.get("sha256"):
        return None
    return BrandLogo(**value, url=f"/uploads/brand/{value['sha256']}.png")


def theme_logos(has_dark: bool) -> list[ThemeLogo]:
    """The logo each built-in theme uses (the Branding preview's note)."""
    from oracle.templates.builtins import BUILTIN_THEMES

    out = []
    for theme in BUILTIN_THEMES:
        background = theme_background(theme.tokens) or "#ffffff"
        dark = has_dark and dark_background(background)
        out.append(
            ThemeLogo(
                key=theme.key,
                name=theme.name,
                background=background,
                variant="dark" if dark else "light",
            )
        )
    return out


async def _out(db: AsyncSession, principal: Principal) -> BrandingOut:
    value = await stored(db)
    logo_dark = _logo(value.get("logo_dark"))
    return BrandingOut(
        display_name=await brand_name(db, value),
        logo=_logo(value.get("logo")),
        logo_dark=logo_dark,
        accent=value.get("accent"),
        public_disclaimer=value.get("public_disclaimer") or DEFAULT_DISCLAIMER,
        oracle_mark=bool(value.get("oracle_mark", True)),
        revision=int(value.get("revision") or 0),
        can_edit=has_role(principal.role, "owner")
        and principal.run_id is None
        and principal.run_token_id is None,
        theme_logos=theme_logos(logo_dark is not None),
    )


def _invalid(message: str) -> HTTPException:
    return HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, message)


def _no_run_token(principal: Principal) -> None:
    if principal.run_token_id is not None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "A run's agents do not read branding")


async def _owner_now(db: AsyncSession, principal: Principal) -> None:
    await not_for_runs(principal)
    await recheck_caller(db, principal, "owner")


@router.get("/v1/branding", response_model=BrandingOut)
async def get_branding(principal: Viewer, db: TenantDB) -> BrandingOut:
    """The company's branding (every member reads it; ``can_edit`` for owners). A run's
    own token is refused: a run's agents never need it."""
    _no_run_token(principal)
    return await _out(db, principal)


@router.put(
    "/v1/branding",
    response_model=BrandingOut,
    responses={403: {"description": "Not an owner, or a run"}, 422: {"description": "Invalid"}},
)
async def put_branding(body: BrandingIn, principal: Owner, db: TenantDB) -> BrandingOut:
    """Display name, accent (contrast-checked), public disclaimer and Oracle's mark on
    shared pages (owners)."""
    await _owner_now(db, principal)
    name = body.display_name.strip()
    if not name or len(name) > MAX_NAME:
        raise _invalid(f"The display name must be 1 to {MAX_NAME} characters")
    if not _not_placeholder(name):
        raise _invalid(STAND_IN)
    disclaimer = body.public_disclaimer.strip()
    if not disclaimer or len(disclaimer) > MAX_DISCLAIMER:
        raise _invalid(f"The public disclaimer must be 1 to {MAX_DISCLAIMER} characters")
    try:
        accent = check_accent(body.accent or None)
    except ValueError as e:
        raise _invalid(str(e)) from None
    value = await stored(db)
    value.update(
        display_name=name, accent=accent, public_disclaimer=disclaimer, oracle_mark=body.oracle_mark
    )
    await _save(db, principal, value, "branding.update")
    await db.commit()
    return await _out(db, principal)


@router.post(
    "/v1/branding/logo",
    response_model=BrandingOut,
    responses={
        403: {"description": "Not an owner, or a run"},
        422: {"description": "Not a PNG, JPEG or WebP, over 512 KB or over 2,000 px"},
    },
)
async def upload_brand_logo(
    principal: Owner,
    db: TenantDB,
    file: Annotated[UploadFile, File()],
    variant: Variant = Query("light"),
) -> BrandingOut:
    """Store a logo (PNG, JPEG or WebP; re-encoded to PNG) as the light or dark variant."""
    await _owner_now(db, principal)
    data = await file.read(MAX_LOGO_BYTES + 1)
    try:
        png, width, height = reencode_logo(data)
    except InvalidLogo as e:
        raise _invalid(str(e)) from None
    sha = hashlib.sha256(png).hexdigest()
    if await db.scalar(select(BrandAsset.id).where(BrandAsset.sha256 == sha)) is None:
        try:
            async with db.begin_nested():
                db.add(
                    BrandAsset(
                        sha256=sha,
                        content_type="image/png",
                        bytes=png,
                        width=width,
                        height=height,
                        created_by=principal.id,
                    )
                )
        except IntegrityError:
            pass  # the same image, stored by an upload alongside: its row serves
    value = await stored(db)
    value["logo" if variant == "light" else "logo_dark"] = {
        "sha256": sha,
        "type": "image/png",
        "width": width,
        "height": height,
    }
    await db.flush()
    await _drop_unused(db, value)
    await _save(db, principal, value, "branding.logo_upload")
    await db.commit()
    return await _out(db, principal)


@router.delete(
    "/v1/branding/logo",
    response_model=BrandingOut,
    responses={403: {"description": "Not an owner, or a run"}},
)
async def delete_brand_logo(
    principal: Owner, db: TenantDB, variant: Variant = Query("light")
) -> BrandingOut:
    """Remove the light or dark logo (owners)."""
    await _owner_now(db, principal)
    value = await stored(db)
    value["logo" if variant == "light" else "logo_dark"] = None
    await _drop_unused(db, value)
    await _save(db, principal, value, "branding.logo_delete")
    await db.commit()
    return await _out(db, principal)


@router.get(
    "/uploads/brand/{name}",
    response_class=Response,
    responses={200: {"content": {"image/png": {}}}, 404: {"description": "No such logo"}},
)
async def get_brand_logo(name: str, principal: Viewer, db: TenantDB) -> Response:
    """A stored logo, to members of its company only, as a PNG that runs nothing."""
    _no_run_token(principal)
    sha, dot, ext = name.partition(".")
    if dot != "." or ext != "png" or not _SHA.match(sha):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    asset = await db.scalar(select(BrandAsset).where(BrandAsset.sha256 == sha))
    if asset is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not found")
    return Response(content=asset.bytes, media_type="image/png", headers=LOGO_HEADERS)
