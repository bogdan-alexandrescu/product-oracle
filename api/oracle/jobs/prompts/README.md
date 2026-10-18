# Built-in job prompts

One system prompt per job kind, versioned by file name (`<kind>.v<N>.md`). A job records
the prompt it ran with (`llm_jobs.input.prompt`), so a report or suggestion can always be
traced to the exact instructions behind it. To change a prompt, add `<kind>.v<N+1>.md`
and point `oracle.jobs.prompting.CURRENT` at it; never edit a version a job has used.

The user message of every job is a JSON object built by `oracle.jobs.kinds`; each prompt
says what it contains and the single JSON object to answer with.
