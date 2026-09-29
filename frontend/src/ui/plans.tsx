/* Схемы объектов. Крупные чертежи лежат файлами в assets/plans, здесь только мелкие
   пиктограммы для стопки: уменьшенный чертеж в квадрате 46 на 30 не читается. */
import airport from "../assets/plans/airport.svg";
import clinic from "../assets/plans/clinic.svg";
import other from "../assets/plans/other.svg";
import warehouse from "../assets/plans/warehouse.svg";

export const PLANS: Record<string, string> = { warehouse, airport, clinic, other };

export const STAMPS: Record<string, string> = {
  warehouse: "план зоны",
  airport: "перрон · схема",
  clinic: "корпус · схема",
  other: "каталог",
};

const LINE = "var(--blue-line)";
const ROUTE = "var(--route)";

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <svg width="46" height="30" viewBox="0 0 46 30" fill="none" aria-hidden="true">
      {children}
    </svg>
  );
}

export function Mini({ id }: { id: string }) {
  if (id === "airport") {
    return (
      <Frame>
        <path
          d="M23 4c1.2 0 2 1.5 2 3.4v3.4l10.4 4.4v2l-10.4-2.4v5l3.4 2.4v1.5l-5.4-1-5.4 1v-1.5l3.4-2.4v-5L10.6 17.2v-2L21 10.8V7.4C21 5.5 21.8 4 23 4z"
          stroke={LINE}
          strokeWidth="1"
        />
        <path d="M7 26h32" stroke={ROUTE} strokeWidth="1" strokeDasharray="3 3" />
      </Frame>
    );
  }

  if (id === "clinic") {
    return (
      <Frame>
        <rect x="6" y="5" width="34" height="20" stroke={LINE} strokeWidth="1" />
        <rect x="10" y="8" width="8" height="7" stroke={LINE} strokeWidth=".9" />
        <rect x="20" y="8" width="8" height="7" stroke={LINE} strokeWidth=".9" />
        <path d="M34 9v5M31.5 11.5h5" stroke={LINE} strokeWidth="1.2" />
        <path d="M10 21h26" stroke={ROUTE} strokeWidth="1" strokeDasharray="3 3" />
        <rect x="20" y="18" width="6" height="6" rx="1.4" fill={ROUTE} />
      </Frame>
    );
  }

  if (id === "other") {
    return (
      <Frame>
        <rect x="6" y="5" width="34" height="20" stroke={LINE} strokeWidth="1" strokeDasharray="4 3" />
        <path
          d="M20 19c0-3.4 4.6-3.4 4.6-7 0-2.3-1.9-3.7-4.2-3.7-1.9 0-3.3.9-4.2 2.3"
          stroke={ROUTE}
          strokeWidth="1.3"
        />
        <circle cx="22" cy="22" r="1.2" fill={ROUTE} />
      </Frame>
    );
  }

  return (
    <Frame>
      <rect x="6" y="5" width="34" height="20" stroke={LINE} strokeWidth="1" />
      <g stroke={LINE} strokeWidth=".8">
        <rect x="10" y="9" width="10" height="3.4" />
        <rect x="10" y="16" width="10" height="3.4" />
        <rect x="26" y="9" width="10" height="3.4" />
        <rect x="26" y="16" width="10" height="3.4" />
      </g>
      <rect x="21" y="12" width="4.4" height="4.4" rx="1.2" fill={ROUTE} />
      <path d="M17 25h5M24 25h5" stroke="var(--blue)" strokeWidth="1.6" />
    </Frame>
  );
}
