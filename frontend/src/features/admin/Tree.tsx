import { useEffect, useState } from "react";
import { catalog, type TreeNode } from "../../api/admin";
import { Alert, Waiting } from "../../ui";

// Каталог деревом, как в ТЗ: отрасль -> тип объекта -> задача -> тип решения -> решение.
// Ветки раскрываются по щелчку, решение открывает свою карточку в списке.

const LEVELS = ["отрасль", "объект", "задача", "тип решения"];

export function CatalogTree({ onOpen }: { onOpen: (id: string, name: string) => void }) {
  const [nodes, setNodes] = useState<TreeNode[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    catalog
      .tree()
      .then(setNodes)
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Не получилось загрузить дерево"));
  }, []);

  if (error) return <Alert>{error}</Alert>;
  if (!nodes) return <Waiting title="Собираем дерево каталога" />;
  return (
    <div className="a-tree">
      <p className="a-faint">
        Уровни: {LEVELS.join(" → ")} → решение. Объект и задача из привязок решения, подтвержденных и предложенных;
        решение с несколькими задачами стоит в нескольких ветках.
      </p>
      <Branch nodes={nodes} depth={0} onOpen={onOpen} />
    </div>
  );
}

function Branch({
  nodes,
  depth,
  onOpen,
}: {
  nodes: TreeNode[];
  depth: number;
  onOpen: (id: string, name: string) => void;
}) {
  return (
    <ul className="a-tree-list">
      {nodes.map((node) =>
        node.solution_id ? (
          <li key={node.solution_id}>
            <button className="a-tree-leaf" onClick={() => onOpen(node.solution_id!, node.name)}>
              {node.name}
            </button>
          </li>
        ) : (
          <li key={node.name}>
            <details open={depth === 0 && nodes.length === 1}>
              <summary>
                {node.name} <span className="a-count">{node.count}</span>
              </summary>
              <Branch nodes={node.children ?? []} depth={depth + 1} onOpen={onOpen} />
            </details>
          </li>
        ),
      )}
    </ul>
  );
}
