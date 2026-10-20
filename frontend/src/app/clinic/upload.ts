import { loadImage, readFile, type Underlay } from "../plan/underlay";

export const CLINIC_PLAN_ACCEPT = ".png,.jpg,.jpeg,.webp,.dxf,.json";

export function clinicFileProblem(file: { name: string; size: number }): string {
  if (!/\.(png|jpe?g|webp|dxf|json)$/i.test(file.name))
    return "Подойдут PNG, JPG, WebP, DXF или JSON корпуса. Страницу PDF сохраните картинкой, DWG: как DXF";
  const limit = /\.dxf$/i.test(file.name) ? 80 : /\.json$/i.test(file.name) ? 4 : 15;
  return file.size > limit * 1024 * 1024
    ? `Файл больше ${limit} МБ. Сохраните только нужный этаж или уменьшите изображение`
    : "";
}

export async function clinicImage(src: string, width: number, length: number, label: string): Promise<Underlay> {
  const image = await loadImage(src);
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Браузер не смог открыть изображение");
  let size = Math.min(1600, Math.max(image.naturalWidth, image.naturalHeight));
  let data: string;
  do {
    const scale = size / Math.max(image.naturalWidth, image.naturalHeight);
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    data = canvas.toDataURL("image/jpeg", 0.85);
    size = Math.floor(size * 0.8);
  } while (data.length > 280_000 && size >= 240);
  if (data.length > 300_000) throw new Error("Изображение слишком сложное. Обрежьте его до одного этажа");
  return { src: data, x: 0, y: 0, w: width, h: length, opacity: 0.6, label };
}

export async function clinicImageFile(file: File, width: number, length: number): Promise<Underlay> {
  const problem = clinicFileProblem(file);
  if (problem) throw new Error(problem);
  return clinicImage(await readFile(file), width, length, file.name);
}

export async function rotateClinicImage(underlay: Underlay): Promise<Underlay> {
  const source = await loadImage(underlay.src);
  const canvas = document.createElement("canvas");
  canvas.width = source.naturalHeight;
  canvas.height = source.naturalWidth;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Не удалось повернуть подложку");
  context.translate(canvas.width, 0);
  context.rotate(Math.PI / 2);
  context.drawImage(source, 0, 0);
  const image = await clinicImage(
    canvas.toDataURL("image/jpeg", 0.85),
    underlay.h,
    underlay.w,
    underlay.label ?? "План этажа",
  );
  return {
    ...image,
    opacity: underlay.opacity,
    x: underlay.x + (underlay.w - underlay.h) / 2,
    y: underlay.y + (underlay.h - underlay.w) / 2,
  };
}
