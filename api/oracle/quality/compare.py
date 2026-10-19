"""Compare the rules with human ratings and model output.

The rules are the reference only because they are deterministic and explained; neither
the model nor a single rater is ground truth. Agreement is reported, never enforced.
"""

from dataclasses import dataclass, field


@dataclass
class Agreement:
    compared: dict[str, int] = field(default_factory=dict)
    human_agreement: float | None = None
    model_agreement: float | None = None
    # Criterion -> {"rules": status, "human": [statuses], "model": status}.
    disagreements: dict[str, dict] = field(default_factory=dict)


def agreement(
    rules: dict[str, str],
    *,
    human: list[dict[str, str]] | None = None,
    model: dict[str, str] | None = None,
) -> Agreement:
    out = Agreement(compared={"human": 0, "model": 0})
    hits = {"human": 0, "model": 0}
    for rating in human or []:
        for key, status in rating.items():
            if key not in rules:
                continue
            out.compared["human"] += 1
            if status == rules[key]:
                hits["human"] += 1
            else:
                out.disagreements.setdefault(key, {"rules": rules[key]}).setdefault(
                    "human", []
                ).append(status)
    for key, status in (model or {}).items():
        if key not in rules:
            continue
        out.compared["model"] += 1
        if status == rules[key]:
            hits["model"] += 1
        else:
            out.disagreements.setdefault(key, {"rules": rules[key]})["model"] = status
    if out.compared["human"]:
        out.human_agreement = hits["human"] / out.compared["human"]
    if out.compared["model"]:
        out.model_agreement = hits["model"] / out.compared["model"]
    return out
