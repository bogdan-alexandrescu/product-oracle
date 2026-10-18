"""File uploads into an upload source: Markdown, plain text and PDF become ``file`` items.

The file name is the item's external id, so uploading a file again with new content
writes a new version of the same item, and the same content writes none.
"""

import io
from dataclasses import dataclass
from pathlib import PurePath

from pypdf import PdfReader
from pypdf.errors import PdfReadError

from oracle.sources.base import ItemUpsert

MAX_BYTES = 20 * 1024 * 1024
EXTENSIONS = (".md", ".markdown", ".txt", ".pdf")


class UploadError(Exception):
    pass


@dataclass(frozen=True)
class UploadedFile:
    filename: str
    data: bytes


def _name(filename: str | None) -> str:
    # Browsers send a bare name; keep only the last path part of anything else.
    name = PurePath((filename or "").replace("\\", "/")).name.strip()
    if not name:
        raise UploadError("Every file needs a name")
    return name


def _pdf_text(name: str, data: bytes) -> str:
    try:
        reader = PdfReader(io.BytesIO(data))
        pages = [page.extract_text() or "" for page in reader.pages]
    except (PdfReadError, ValueError, KeyError, TypeError) as e:
        raise UploadError(f"{name}: not a readable PDF ({type(e).__name__})") from None
    text = "\n\n".join(p.strip() for p in pages if p.strip())
    if not text:
        raise UploadError(f"{name}: the PDF has no text layer (scanned pages are not read)")
    return text


def to_item(upload: UploadedFile) -> ItemUpsert:
    name = _name(upload.filename)
    ext = PurePath(name).suffix.lower()
    if ext not in EXTENSIONS:
        raise UploadError(f"{name}: only .md, .txt and .pdf files can be uploaded")
    if len(upload.data) > MAX_BYTES:
        raise UploadError(f"{name}: larger than {MAX_BYTES // (1024 * 1024)} MB")
    if ext == ".pdf":
        content = _pdf_text(name, upload.data)
    else:
        try:
            content = upload.data.decode("utf-8-sig")
        except UnicodeDecodeError:
            raise UploadError(f"{name}: not UTF-8 text") from None
        if not content.strip():
            raise UploadError(f"{name}: the file is empty")
    return ItemUpsert(
        external_id=name,
        kind="file",
        title=name,
        url=None,
        author=None,
        content=content,
        acl={"visibility": "owner", "format": ext.lstrip(".")},
    )
