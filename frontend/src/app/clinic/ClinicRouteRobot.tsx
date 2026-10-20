import type { ClinicRobots } from "../../api/client";
import { Button, Select } from "../../ui";

export function ClinicRouteRobot({
  robots,
  robotId,
  onPick,
  multiFloor,
}: {
  robots: ClinicRobots | null;
  robotId: string;
  onPick: (id: string) => void;
  multiFloor: boolean;
}) {
  if (!robots) return <p className="muted">Загружаем модели для проверки маршрутов…</p>;
  const available = robots.delivery.filter((robot) => !robot.missing.length);
  const selected = available.find((robot) => robot.id === robotId);
  const withLift = available.find((robot) => robot.lift);
  const clearance = selected?.specs?.find((spec) => spec.field === "min_aisle_width_mm")?.value;
  return (
    <div className="c-route-robot">
      <div>
        <p className="u-frow-name">Робот для проверки и прогона</p>
        <Select
          label="Робот для проверки и прогона"
          value={robotId}
          onChange={onPick}
          options={[
            ...(!selected ? [{ id: robotId, name: "Выбранная модель недоступна для прогона" }] : []),
            ...available.map((robot) => ({ id: robot.id, name: robot.product })),
          ]}
        />
      </div>
      <div className="c-route-robot-note">
        <p className="muted">
          {clearance != null && <>Нужен проход от {clearance} мм. </>}
          {selected?.lift
            ? "Работа с лифтом подтверждена в каталоге. Нужны интеграция лифта, подходящая кабина и доступный вход на каждом этаже."
            : "Работа с лифтом у этой модели не подтверждена в каталоге. На своем этаже она может ездить; межэтажные заявки останутся невыполненными."}
        </p>
        <p className="u-frow-hint">Выбор применяется и на шаге "Решения". План и двери при смене модели сохраняются.</p>
        {selected && !selected.lift && multiFloor && withLift && (
          <Button kind="ghost" onClick={() => onPick(withLift.id)}>
            Выбрать модель с лифтом
          </Button>
        )}
      </div>
    </div>
  );
}
