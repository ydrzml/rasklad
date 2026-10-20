/* Смена на плане корпуса: тот же парк, что в итоге, едет по нарисованным этажам. Значки роботов
   цвета действия, кабина лифта в шахте того этажа, где она сейчас, с числом роботов внутри. Этажи
   переключаются, часы и кнопки как у смены склада (ui/player). Считает сервер, здесь только лог */
import { useEffect, useMemo, useState } from "react";

import { api, type ClinicRun } from "../../api/client";
import { Alert, Button, Timeline, Waiting, type View } from "../../ui";
import { Board, Legend, Modes } from "../../ui/board";
import { Clock, Player, useClock } from "../../ui/player";
import { number, percent } from "../format";
import { ACTION_COLOR, mixOf, minutesOf, queuesOf, replayOf } from "../shift/replay";
import { Score } from "../shift/Score";
import { ClinicLayer } from "./ClinicLayer";
import { type Building, floorOf } from "./building";
import { FloorDrawing, screenY } from "./FloorDrawing";
import { cabinAt, spotOf, type Track, tracksOf } from "./shift";

const SPEEDS = [
  { value: 60, name: "×60" },
  { value: 240, name: "×240" },
  { value: 900, name: "×900" },
];
const LIFT_COLOR = "var(--ink)";
const SHOWN = ["едет", "грузит", "моет", "ждет", "заряжается", "без задания", "в лифте"];

type Props = {
  building: Building;
  fleet: number;
  cleaners: Record<string, number>;
  robotId: string;
  cleanerId: string | null;
  operationIds: string[];
  overrides: Record<string, number>;
};

export function ClinicShift({ building, fleet, cleaners, robotId, cleanerId, operationIds, overrides }: Props) {
  // ответ с ключом запроса: старый ответ после правки не показываем, пока не пришел новый
  const [answer, setAnswer] = useState<{ key: string; run: ClinicRun | null; error: string } | null>(null);
  const [floorNo, setFloorNo] = useState(building.floors[0]?.number ?? 1);
  const [attempt, setAttempt] = useState(0);
  const [board, setBoard] = useState<{ view: View; area: { w: number; h: number } }>({
    view: { s: 1, tx: 0, ty: 0 },
    area: { w: 0, h: 0 },
  });
  const key = JSON.stringify([building, fleet, cleaners, robotId, cleanerId, operationIds, overrides, attempt]);

  useEffect(() => {
    const abort = new AbortController();
    api
      .clinicRun(
        {
          building,
          fleet,
          robot_id: robotId,
          cleaner_id: cleanerId,
          cleaners,
          operation_ids: operationIds,
          overrides,
        },
        abort.signal,
      )
      .then((run) => setAnswer({ key, run, error: "" }))
      .catch((reason: unknown) => {
        if (abort.signal.aborted) return;
        setAnswer({ key, run: null, error: reason instanceof Error ? reason.message : "Сервер не ответил" });
      });
    return () => abort.abort();
    // запрос зависит только от ключа: корпус, парк, уборка и правки
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const run = answer?.key === key ? answer.run : null;
  const error = answer?.key === key ? answer.error : "";
  const tracks = useMemo(() => (run ? tracksOf(run.segments) : []), [run]);
  const clock = useClock((run?.hours ?? 8) * 3600);
  const replay = useMemo(
    () =>
      run
        ? replayOf(
            run.segments.map((segment) => ({
              ...segment,
              action: segment.action === "в лифте" ? "едет" : segment.action,
            })),
            run.hours,
          )
        : null,
    [run],
  );
  const mix = useMemo(() => (replay ? mixOf(replay) : []), [replay]);
  const queues = useMemo(() => (replay ? queuesOf(minutesOf(replay)) : []), [replay]);
  useEffect(() => {
    if (!run) return;
    clock.set(0);
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      clock.setSpeed(240);
      clock.play(true);
    }
    return () => clock.play(false);
  }, [run, clock]);

  if (error)
    return (
      <>
        <Alert>Смена не прогналась: {error}</Alert>
        <Button kind="ghost" onClick={() => setAttempt(attempt + 1)}>
          Повторить
        </Button>
      </>
    );
  if (!run) return <Waiting title="Гоняем смену на вашем корпусе" />;

  const floor = floorOf(building, floorNo) ?? building.floors[0];
  const floors = [...building.floors].sort((a, b) => a.number - b.number);
  const kpi = run.kpi;

  return (
    <div className="c-shift">
      <div className="u-shift-grid">
        <div className="u-shift-main">
          <p className="c-shift-line">
            Доставщиков {run.fleet}, уборщиков {Object.values(run.cleaners).reduce((sum, count) => sum + count, 0)},
            заявок {kpi.created}, вовремя {kpi.on_time_share == null ? "нет заявок" : percent(kpi.on_time_share)}, в
            среднем {kpi.avg_delivery_min == null ? "нет" : `${number(kpi.avg_delivery_min, 0)} мин`} от заявки до
            поста.
            {kpi.lifts.length > 0 &&
              ` Лифты заняты: ${kpi.lifts.map((one) => `${one.lift} ${percent(one.busy_share)}`).join(", ")}.`}
          </p>
          <div className="c-floors">
            <Where clock={clock} tracks={tracks} floors={floors.map((one) => one.number)} />
            <Modes
              label="Этаж"
              value={String(floor.number)}
              options={floors.map((one) => ({ id: String(one.number), name: one.name || `${one.number} этаж` }))}
              onChange={(next) => setFloorNo(Number(next))}
            />
          </div>
          <div className="c-shift-board">
            <Board
              widthM={floor.width_m}
              lengthM={floor.length_m}
              fit={{ x: 0, y: 0, w: floor.width_m, h: floor.length_m }}
              fitKey={`${floor.width_m}:${floor.length_m}`}
              label={`Смена на этаже ${floor.number}`}
              onView={(view, area) =>
                setBoard((old) =>
                  old.view === view && old.area.w === area.w && old.area.h === area.h ? old : { view, area },
                )
              }
              overlay={
                <ClinicLayer
                  view={board.view}
                  area={board.area}
                  length={floor.length_m}
                  tracks={tracks}
                  floor={floor.number}
                  clock={clock}
                />
              }
              onKey={(event) => {
                if (event.key === " ") {
                  event.preventDefault();
                  clock.play();
                }
              }}
            >
              {(view) => (
                <>
                  <FloorDrawing floor={floor} scale={view.s} />
                  <Moving
                    clock={clock}
                    run={run}
                    tracks={tracks}
                    building={building}
                    floorNo={floor.number}
                    scale={view.s}
                  />
                </>
              )}
            </Board>
          </div>
          <div className="u-shift-player">
            <Player clock={clock} speeds={SPEEDS}>
              <span className="c-shift-start mono">смена с {run.shift_start_h}:00</span>
              <Legend
                rows={SHOWN.filter((action) => run.segments.some((one) => one.action === action)).map((action) => ({
                  id: action,
                  color: action === "в лифте" ? LIFT_COLOR : (ACTION_COLOR[action] ?? "var(--ink-faint)"),
                  name: action,
                }))}
              />
            </Player>
            {replay && (
              <>
                <Timeline
                  clock={clock}
                  demand={run.demand_per_hour}
                  stack={[...new Set(run.segments.map((one) => (one.action === "в лифте" ? "едет" : one.action)))].map(
                    (action) => ({
                      id: action,
                      name: action,
                      color: ACTION_COLOR[action] ?? LIFT_COLOR,
                      shares: mix.map((minute) => minute[action] ?? 0),
                    }),
                  )}
                  fleet={tracks.length}
                  queues={queues}
                />
                <Score
                  replay={replay}
                  clock={clock}
                  demand={run.demand_per_hour}
                  waiting={run.kpi.shares?.["ждет"] ?? 0}
                />
              </>
            )}
          </div>
        </div>
        <aside className="u-side u-shift-side">
          <h3>Парк</h3>
          <p className="u-shift-fleet">
            <b className="mono">{tracks.length}</b> роботов
          </p>
          <p>
            Доставщиков: {run.fleet}. Уборщиков: {Object.values(run.cleaners).reduce((sum, count) => sum + count, 0)}.
          </p>
          {run.search?.needed === null && <Alert>Цель доставки не достигнута: {run.search.stopped}</Alert>}
          <h3>Результат смены</h3>
          <p>
            Выполнено {kpi.done} из {kpi.created} заявок. Вовремя:{" "}
            {kpi.on_time_share == null ? "нет заявок" : percent(kpi.on_time_share)}.
          </p>
          {kpi.blocked > 0 && <Alert>Недоступных заявок: {kpi.blocked}. Проверьте двери и лифты.</Alert>}
          {kpi.cleaning.map((one) => (
            <p key={one.floor}>
              {one.floor} этаж: вымыто {number(one.done_m2, 0)} из {number(one.area_m2, 0)} м².
            </p>
          ))}
          <p className="u-shift-note">Узкое место: {kpi.bottleneck}.</p>
        </aside>
      </div>
    </div>
  );
}

/* Где роботы сейчас: этаж пустой не значит, что смена встала, робот на другом этаже или в лифте */
function Where({ clock, tracks, floors }: { clock: Clock; tracks: Track[]; floors: number[] }) {
  const [t, setT] = useState(clock.t);
  useEffect(() => clock.subscribe(() => setT(clock.t)), [clock]);
  const spots = tracks.map((track) => spotOf(track, t)).filter((spot) => spot !== null);
  const lift = spots.filter((spot) => spot.floor === null).length;
  const parts = floors
    .map((number) => [number, spots.filter((spot) => spot.floor === number).length] as const)
    .filter(([, count]) => count > 0)
    .map(([number, count]) => `${number} этаж: ${count}`);
  if (lift) parts.push(`в лифте: ${lift}`);
  return <span className="c-where mono">Сейчас {parts.join(", ") || "роботов на плане нет"}</span>;
}

/* Слой с роботами и кабинами: подписан на часы сам, остальной экран кадров не видит */
function Moving({
  clock,
  run,
  tracks,
  building,
  floorNo,
  scale,
}: {
  clock: Clock;
  run: ClinicRun;
  tracks: Track[];
  building: Building;
  floorNo: number;
  scale: number;
}) {
  const [t, setT] = useState(clock.t);
  useEffect(() => clock.subscribe(() => setT(clock.t)), [clock]);
  const floor = floorOf(building, floorNo)!;
  const shafts = floor.items.filter((item) => item.kind === "lift");
  const spots = tracks.map((track) => spotOf(track, t)).filter((spot) => spot !== null);
  return (
    <g pointerEvents="none">
      {shafts.map((shaft) => {
        const cabin = cabinAt(run.lift_segments, shaft.lift, t);
        if (!cabin || Math.abs(cabin.floor - floorNo) >= 0.5) return null;
        const inside = spots.filter((spot) => spot.floor === null && spot.lift === shaft.lift).length;
        return (
          <g key={shaft.id}>
            <rect
              x={shaft.x + 0.3}
              y={screenY(floor, shaft) + 0.3}
              width={shaft.w - 0.6}
              height={shaft.h - 0.6}
              className="c-cabin"
            />
            {inside > 0 && (
              <text
                x={shaft.x + shaft.w / 2}
                y={screenY(floor, shaft) + shaft.h / 2}
                className="c-cabin-count"
                style={{ fontSize: 12 / scale }}
              >
                {inside}
              </text>
            )}
          </g>
        );
      })}
    </g>
  );
}
