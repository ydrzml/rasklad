import { useEffect, useState } from "react";
import { projects, type Version, type VersionSummary } from "../../api/projects";
import { saveBlob } from "../../app/saving";
import { Alert, Button } from "../../ui";
import { problem, when } from "./format";

// Сохраненная версия проекта (ТЗ, п. 3.1.5): когда посчитана, какой моделью и на каких данных.
// Отчет собирается из сохраненных цифр, без пересчета. Если нормативы с тех пор поменялись,
// версию можно посчитать заново: получится новая версия, эта остается как была.

type Props = {
  projectId: number;
  summary: VersionSummary;
  onRecalculated: (made: Version) => Promise<void>;
};

export function VersionCard({ projectId, summary, onRecalculated }: Props) {
  const number = summary.number;
  // есть ли в версии сохраненные цифры, видно только по ней самой: список версий их не несет
  const [full, setFull] = useState<Version | null>(null);
  const [exporting, setExporting] = useState<"pdf" | "xlsx" | null>(null);
  const [recalculating, setRecalculating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    projects
      .version(projectId, number)
      .then((found) => live && setFull(found))
      .catch((reason) => live && setError(problem(reason)));
    return () => {
      live = false;
    };
  }, [projectId, number]);

  const empty = full !== null && !full.result;

  async function download(kind: "pdf" | "xlsx") {
    setExporting(kind);
    setError(null);
    try {
      const { blob, name } = await projects.report(projectId, number, kind);
      saveBlob(blob, name);
    } catch (reason) {
      setError(`Файл не собрался: ${problem(reason)}`);
    } finally {
      setExporting(null);
    }
  }

  async function recalculate() {
    setRecalculating(true);
    setError(null);
    try {
      await onRecalculated(await projects.recalculate(projectId, number));
    } catch (reason) {
      setError(`Не пересчиталось: ${problem(reason)}`);
      setRecalculating(false);
    }
  }

  const busy = exporting !== null || recalculating;

  return (
    <section className="c-version" aria-labelledby={`version-${projectId}-${number}`}>
      <h3 className="c-sub" id={`version-${projectId}-${number}`}>
        Версия {number}
      </h3>
      <dl className="c-stamp">
        <dt>Расчет</dt>
        <dd className="mono">{when(summary.saved_at)} мск</dd>
        <dt>Версия методики</dt>
        <dd className="mono">{summary.model_version}</dd>
        <dt>Каталог и нормативы</dt>
        <dd>
          {summary.data_note || "как были при сохранении"}
          {/* отпечаток служебный: нужен, только чтобы сверить расчет, поэтому спрятан */}
          <details className="c-faint c-note">
            <summary>для проверки</summary>
            отпечаток данных <span className="mono">{summary.data_version}</span>
          </details>
        </dd>
      </dl>

      {empty ? (
        <Alert tone="note">
          В этой версии нет сохраненных цифр: ее сохранили до того, как мы стали их хранить. Пересчитайте ее, и отчет
          соберется по новой версии.
        </Alert>
      ) : (
        !summary.same_data && (
          <Alert tone="note">
            Нормативы обновились после расчета. Цифры и отчет этой версии остаются как были. Чтобы увидеть цифры на
            текущих нормативах, пересчитайте: появится новая версия, эта не изменится.
          </Alert>
        )
      )}
      {error && <Alert>{error}</Alert>}

      <div className="c-row">
        {!empty && (
          <>
            <Button kind="light" disabled={busy || full === null} onClick={() => void download("pdf")}>
              {exporting === "pdf" ? "Собираем отчет..." : "Отчет PDF"}
            </Button>
            <Button kind="light" disabled={busy || full === null} onClick={() => void download("xlsx")}>
              {exporting === "xlsx" ? "Собираем таблицы..." : "Таблицы Excel"}
            </Button>
          </>
        )}
        {(empty || !summary.same_data) && (
          <Button kind="ghost" disabled={busy} onClick={() => void recalculate()}>
            {recalculating ? "Пересчитываем..." : "Пересчитать как новую версию"}
          </Button>
        )}
        <span className="c-gap" />
        <Button kind="link" href={`/calc?project=${projectId}&version=${number}&open=1`}>
          Открыть в расчете
        </Button>
      </div>
      {!empty && <p className="c-faint c-hint">Отчет собирается из сохраненных цифр, без пересчета.</p>}
    </section>
  );
}
