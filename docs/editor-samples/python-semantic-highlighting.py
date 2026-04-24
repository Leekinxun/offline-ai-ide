from contextlib import nullcontext
from dataclasses import dataclass, field
from typing import Final, TypedDict, TypeAlias

UserId: TypeAlias = int
GLOBAL_CACHE: dict[str, str] = {}
MAX_RETRIES: Final[int] = 3


class UserPayload(TypedDict):
    name: str
    score: int


@dataclass
class Worker:
    name: str
    retries: int = field(default=0)

    def _lock(self):
        return nullcontext()

    async def run(self, tasks: list[str]) -> dict[str, int]:
        total_processed = 0
        stats = {"ok": 0, "errors": 0}

        def consume(batch: list[str]) -> None:
            nonlocal total_processed
            for item in batch:
                total_processed += len(item)

        with (
            open("worker.log", "a", encoding="utf-8") as handle,
            self._lock() as lock_handle,
        ):
            (
                first_task,
                second_task,
            ) = tasks[:2]

            indexed_tasks = [
                (index, cleaned_name.upper())
                for index, raw_name in enumerate(tasks)
                if (cleaned_name := raw_name.strip())
            ]

            formatter = lambda task_name, limit=MAX_RETRIES: (
                f"{task_name}:{limit}"
            )

            global GLOBAL_CACHE
            GLOBAL_CACHE[first_task] = formatter(second_task)
            consume([name for _, name in indexed_tasks])

            try:
                payload: UserPayload = {"name": self.name, "score": len(tasks)}
                match payload:
                    case {"name": user_name, "score": score}:
                        handle.write(f"{user_name}:{score}\n")
                        stats["ok"] += 1
            except* RuntimeError as grouped_error:
                handle.write(f"runtime-error:{grouped_error}\n")
                stats["errors"] += 1

        return stats
