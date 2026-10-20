/* Как сейчас делают работу поменялось (уборка машиной или вручную), а штат человек уже правил.
   Молча ничего не меняем: предлагаем поставить строки по норме вместо ролей, которые задаче
   больше не нужны. Пока штат не трогали, он и так приходит с сервера целиком (App.tsx). */

export type SwapLine = {
  id: string;
  role: string;
  headcount: number;
  filled: number;
  salary_month: number;
  contractor?: boolean;
};

export type StaffSwap<T extends SwapLine> = {
  /* штат после замены: введенные строки без ушедших ролей плюс строки по норме */
  lines: T[];
  /* роли, которые задаче больше не нужны, и роли, которых не хватает */
  from: string[];
  to: string[];
};

/* defaults: штат по умолчанию для новой постановки, previousRequired: роли, которые задачи
   требовали до нее. Пусто, если менять нечего: роли те же или нужная роль уже есть в штате */
export function swapByNorm<T extends SwapLine>(
  current: T[],
  defaults: T[],
  previousRequired: string[],
): StaffSwap<T> | null {
  const required = defaults.map((line) => line.role);
  const from = previousRequired.filter(
    (role) => !required.includes(role) && current.some((line) => line.role === role),
  );
  const missing = defaults.filter((line) => !current.some((mine) => mine.role === line.role));
  if (from.length === 0 || missing.length === 0) return null;
  return {
    lines: [...current.filter((line) => !from.includes(line.role)), ...missing],
    from,
    to: missing.map((line) => line.role),
  };
}

/* Подпись над штатом: что поменялось и что предлагаем, словами роли из справочника */
export function swapText(swap: { from: string[]; to: string[] }, names: Map<string, string>): string {
  const word = (roles: string[]) => roles.map((role) => `"${names.get(role) ?? role}"`).join(", ");
  return `Поменялось, как сейчас делают работу: задаче нужна роль ${word(swap.to)}, а в штате ${word(swap.from)}. Штат вы правили сами, поэтому мы его не меняли`;
}
