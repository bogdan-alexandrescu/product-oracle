"""AQ1: the questions a run's agents asked at a stop, and a person's answer to one.

Split out of oracle/runs/schemas.py (#1723: that module may only shrink)."""

from datetime import datetime

from pydantic import Field

from oracle.base_model import BaseModel
from oracle.runs.schemas import ReviewPerson


class AgentOptionOut(BaseModel):
    key: str
    label: str
    # What the option costs, as the agent put it.
    detail: str | None = None


class AgentAnswerOut(BaseModel):
    option: str
    note: str | None = None
    by: ReviewPerson | None = None
    at: datetime
    # The caller gave it.
    mine: bool = False


class AgentQuestionOut(BaseModel):
    # The question's id in the agents' file.
    id: str
    # Who asks: analyst, architect, ...
    role: str
    # The key of the feature it is about; None for the whole set.
    feature: str | None = None
    question: str
    why: str | None = None
    options: list[AgentOptionOut]
    # The agent's pick: what the next step goes with when nobody answers.
    recommended: str | None = None
    answer: AgentAnswerOut | None = None


class AgentQuestionsOut(BaseModel):
    questions: list[AgentQuestionOut]
    # The title of the step the answers go to with the stop's decision.
    next_step: str | None = None
    # The caller may answer (the stop's approver role or above, while it is pending).
    can_answer: bool = False


class AgentAnswerIn(BaseModel):
    option: str = Field(min_length=1, max_length=200)
    note: str | None = Field(default=None, max_length=1000)
