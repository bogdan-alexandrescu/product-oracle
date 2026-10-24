"""Oracle's web tools (H7 Competitive digest, lane 1): the only web Oracle's agents reach.

- ``search``: the provider interface (``WebSearchProvider.search(query, n)``), the
  provider the settings name, and the note every result carries;
- ``brave``: the first provider, the Brave Search API (Q5 "Web search", owner
  2026-10-23), with Oracle's key (``ORACLE_WEB_SEARCH_KEY``);
- ``robots``: robots.txt rules for ``ProductOracleBot``, cached a day per host;
- ``fetch``: a page read through ``LinkFetcher`` (https, public addresses only, size and
  time caps), only for a URL this run's searches returned;
- ``models``: ``web_results`` (migration 0052_market) and ``web_searches``
  (0053_web_tools): what each run read and searched, the per-run and monthly counts, and
  the 13-month purge;
- ``router``: ``POST /v1/web/search`` (``search_web``) and ``POST /v1/web/fetch``
  (``fetch_web_page``), for run tokens holding ``read:web`` only.

Everything a result or a page says is untrusted data: it reaches the agent as JSON
fields marked ``untrusted: true``, never as prompt text.
"""
