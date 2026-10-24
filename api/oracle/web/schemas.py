"""Request and response bodies of Oracle's web tools (``search_web``, ``fetch_web_page``).

Each result and page is data marked ``untrusted: true`` with :data:`oracle.web.search.NOTE`.
"""

from datetime import date
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

MAX_QUERY = 200
PAGE_TEXT_CHARS = 20_000


class WebSearchIn(BaseModel):
    query: str = Field(description="What to search for, at most 200 characters.")
    max_results: int = Field(8, ge=1, le=10, description="1-10 results (default 8).")

    @field_validator("query")
    @classmethod
    def _query(cls, value: str) -> str:
        value = " ".join(value.split())
        if not value:
            raise ValueError("Enter a query.")
        if len(value) > MAX_QUERY:
            raise ValueError(f"A query has at most {MAX_QUERY} characters.")
        return value


class WebResultOut(BaseModel):
    ref: str
    url: str
    host: str
    title: str
    snippet: str
    published_on: date | None


class WebSearchOut(BaseModel):
    results: list[WebResultOut]
    untrusted: Literal[True] = True
    note: str
    searches_left: int


class WebFetchIn(BaseModel):
    ref: str | None = Field(None, description="The ref (w-<n>) of a result of this run.")
    url: str | None = Field(None, description="The URL of a result of this run.")

    @model_validator(mode="after")
    def _one(self) -> "WebFetchIn":
        if (self.ref is None) == (self.url is None):
            raise ValueError("Give either the ref or the URL of a result of this run.")
        return self


class WebPageOut(BaseModel):
    ref: str
    url: str
    title: str | None
    text: str = Field(description="The page's text, at most 20,000 characters.")
    untrusted: Literal[True] = True
    note: str
    pages_left: int
