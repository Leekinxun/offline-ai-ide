import { useEffect, useMemo, useState } from "react";

interface TaskCardProps {
  readonly title: string;
  count: number;
  onSelect(taskId: string): void;
}

type TaskRecord = {
  id: string;
  label: string;
  completed: boolean;
};

export function TaskCard({ title, count, onSelect }: TaskCardProps) {
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const completedCount = useMemo(
    () => tasks.filter((task) => task.completed).length,
    [tasks]
  );

  useEffect(() => {
    setTasks([
      { id: "build", label: "Build", completed: true },
      { id: "review", label: "Review", completed: false },
    ]);
  }, []);

  return (
    <section className="task-card">
      <header>
        <h2>{title}</h2>
        <span>{count}</span>
      </header>
      <ul>
        {tasks.map((task) => (
          <li key={task.id}>
            <button type="button" onClick={() => onSelect(task.id)}>
              {task.label}
            </button>
          </li>
        ))}
      </ul>
      <footer>{completedCount} completed</footer>
    </section>
  );
}
