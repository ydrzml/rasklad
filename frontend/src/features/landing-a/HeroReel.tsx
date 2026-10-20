import { useEffect, useRef, useState } from "react";
import { useDark } from "../../ui/theme";

/* Ролик первого экрана: план склада, роботы на маршрутах, подбор, окупаемость и три сценария.
   Играет сам, без звука и без кнопок, по кругу. Файлы в public/hero, для светлой и темной темы свои:
   ролик снят в цветах tokens.css, поэтому при смене темы меняется файл. Пока ролик грузится, стоит
   постер (первый кадр, пустая сетка). Кто просил меньше движения, видит один кадр с тремя сценариями:
   пустая сетка постера ничего бы не рассказала */

const LABEL =
  "Как работает сервис: план склада, роботы на маршрутах, подбор из каталога, окупаемость и три сценария за пять лет";
const REDUCE = "(prefers-reduced-motion: reduce)";

function useReducedMotion(): boolean {
  const [reduce, setReduce] = useState(() => window.matchMedia(REDUCE).matches);
  useEffect(() => {
    const media = window.matchMedia(REDUCE);
    const update = () => setReduce(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return reduce;
}

export function HeroReel() {
  const theme = useDark() ? "dark" : "light";
  const still = useReducedMotion();
  return (
    <div className="la-reel">
      {still ? (
        <img src={`/hero/hero_still_${theme}.webp`} alt={LABEL} width={1152} height={940} />
      ) : (
        // key: при смене темы элемент создается заново, иначе браузер оставил бы прежний файл
        <Loop key={theme} theme={theme} />
      )}
    </div>
  );
}

function Loop({ theme }: { theme: "light" | "dark" }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    // React ставит muted свойством уже после создания, а без него браузер не запустит ролик сам
    video.muted = true;
    video.play().catch(() => {
      // запуск запрещен (экономия трафика и т.п.): остается постер, страница работает как обычно
    });
  }, []);
  return (
    <video
      ref={ref}
      autoPlay
      muted
      loop
      playsInline
      preload="auto"
      poster={`/hero/hero_loop_${theme}.png`}
      width={1152}
      height={940}
      aria-label={LABEL}
    >
      <source src={`/hero/hero_loop_${theme}.webm`} type="video/webm" />
      <source src={`/hero/hero_loop_${theme}.mp4`} type="video/mp4" />
    </video>
  );
}
