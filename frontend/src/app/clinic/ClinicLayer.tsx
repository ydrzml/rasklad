import { useEffect, useRef } from "react";
import type { Clock, View } from "../../ui";
import { ACTION_COLOR } from "../shift/replay";
import { bodyPath, tokenColor } from "../shift/ShiftLayer";
import { spotOf, type Track } from "./shift";

// Корпус и цвета робота берем из проигрывателя склада; этаж и лифт читаем из медицинского лога.
export function ClinicLayer({
  view,
  area,
  length,
  tracks,
  floor,
  clock,
}: {
  view: View;
  area: { w: number; h: number };
  length: number;
  tracks: Track[];
  floor: number;
  clock: Clock;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const headings = useRef(new Map<number, number>());
  useEffect(() => {
    const node = canvas.current;
    const context = node?.getContext("2d");
    if (!node || !context || area.w <= 0 || area.h <= 0) return;
    const ratio = window.devicePixelRatio || 1;
    node.width = Math.round(area.w * ratio);
    node.height = Math.round(area.h * ratio);
    const paper = tokenColor("var(--paper)", node);
    const ink = tokenColor("var(--ink)", node);
    const colors = Object.fromEntries(
      Object.entries(ACTION_COLOR).map(([action, color]) => [action, tokenColor(color, node)]),
    );
    const draw = () => {
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, area.w, area.h);
      const r = Math.max(6, Math.min(11, view.s * 0.65));
      const visible = tracks.flatMap((track) => {
        const spot = spotOf(track, clock.t);
        return spot?.floor === floor ? [spot] : [];
      });
      for (const track of tracks) {
        const spot = spotOf(track, clock.t);
        if (!spot || spot.floor !== floor) continue;
        const was = spotOf(track, Math.max(0, clock.t - 3));
        if (was?.floor === floor && Math.hypot(spot.x - was.x, spot.y - was.y) > 0.05)
          headings.current.set(spot.robot, Math.atan2(-(spot.y - was.y), spot.x - was.x));
        const color = colors[spot.action] ?? ink;
        const long = r * 1.25;
        const wide = r * 0.9;
        context.save();
        const neighbors = visible.filter((other) => Math.hypot(other.x - spot.x, other.y - spot.y) * view.s < r * 2.2);
        const index = neighbors.findIndex((other) => other.robot === spot.robot);
        const offset = neighbors.length > 1 ? r * 1.5 : 0;
        const angle = (Math.PI * 2 * index) / neighbors.length - Math.PI / 4;
        context.translate(
          spot.x * view.s + view.tx + Math.cos(angle) * offset,
          (length - spot.y) * view.s + view.ty + Math.sin(angle) * offset,
        );
        context.rotate(headings.current.get(spot.robot) ?? 0);
        context.beginPath();
        bodyPath(context, spot.role === "cleaning" ? 1 : 0, long, wide, r);
        context.fillStyle = paper;
        context.fill();
        context.lineWidth = Math.max(2, r * 0.28);
        context.strokeStyle = color;
        context.stroke();
        context.fillStyle = ink;
        context.fillRect(long * 0.35, -wide * 0.55, long * 0.35, wide * 1.1);
        context.beginPath();
        context.arc(-long * 0.55, 0, r * 0.28, 0, Math.PI * 2);
        context.fillStyle = color;
        context.fill();
        context.restore();
      }
    };
    draw();
    return clock.subscribe(draw);
  }, [view, area, length, tracks, floor, clock]);
  return <canvas ref={canvas} className="u-shift-layer" style={{ width: area.w, height: area.h }} aria-hidden="true" />;
}
