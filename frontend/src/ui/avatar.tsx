/* Кружок человека: первая буква имени (без имени почты) на цветном фоне. Цвет считается от того же
   текста, поэтому у одного человека он один и в шапке, и в профиле. Цвета из токенов набора.
   Своей картинки пока нет, это задача после первой версии (docs/tasks.md, T-73). */

const COLORS = [
  "var(--blue)",
  "var(--sc-rent)",
  "var(--act-load)",
  "var(--dock-in)",
  "var(--dock-out)",
  "var(--blue-line)",
];

function avatarColor(name: string): string {
  const sum = [...name.trim()].reduce((total, char) => total + char.charCodeAt(0), 0);
  return COLORS[sum % COLORS.length];
}

export function Avatar({ name, size }: { name: string; size?: number }) {
  const letter = name.trim().slice(0, 1).toUpperCase() || "?";
  const box = size ? { width: size, height: size, fontSize: Math.round(size * 0.42) } : {};
  return (
    <span className="u-avatar" aria-hidden="true" style={{ background: avatarColor(name), ...box }}>
      {letter}
    </span>
  );
}
