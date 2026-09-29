import { useState, type ChangeEvent } from "react";

import type { ImportResult, StaffLine } from "../../api/client";
import { api } from "../../api/client";
import { Alert, BlockHead, Button, Sheet, SheetRow } from "../../ui";
import { saveBlob } from "../saving";

type Props = {
  facilityId: string;
  taskIds: string[];
  overrides: Record<string, number>;
  staff: StaffLine[];
  onApply: (overrides: Record<string, number>, staff: StaffLine[] | null) => void;
};

// Данные объекта из файла (ТЗ: импорт Excel/CSV с проверкой). Шаблон скачивается уже заполненным
// тем, что стоит на экране. Загруженный файл сервер разбирает построчно и отвечает отчетом, а
// подставляет человек сам кнопкой: так видно, что пришло из файла, а что пропустили и почему.
export function ImportFile({ facilityId, taskIds, overrides, staff, onApply }: Props) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [report, setReport] = useState<{ name: string; result: ImportResult } | null>(null);
  const [applied, setApplied] = useState<string | null>(null);
  const [over, setOver] = useState(false);

  async function template() {
    setFailure(null);
    try {
      saveBlob(
        await api.importTemplate({ facility_id: facilityId, operation_ids: taskIds, overrides, staff }),
        "shablon-dannyh-obekta.xlsx",
      );
    } catch (error) {
      setFailure(`Шаблон не скачался: ${(error as Error).message}`);
    }
  }

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) await read(file);
  }

  async function read(file: File) {
    setBusy(true);
    setFailure(null);
    setApplied(null);
    try {
      setReport({ name: file.name, result: await api.importFile(file, facilityId, taskIds, overrides) });
    } catch (error) {
      setFailure(`Файл не прочитался: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  function apply() {
    if (!report) return;
    onApply(report.result.overrides, report.result.staff ?? null);
    setApplied(`Подставили значений из файла «${report.name}»: ${report.result.applied}`);
    setReport(null);
  }

  const result = report?.result;
  const noted = result?.rows.filter((row) => row.status !== "ok") ?? [];
  const clean = (result?.rows.length ?? 0) - noted.length;

  return (
    <section>
      <BlockHead title="Данные из файла" />
      {/* плита, как у остальных разделов шага, а не кнопки справа от заголовка отдельно от всего.
          Файл можно бросить на плиту */}
      <div
        className={over ? "u-file-plate is-over" : "u-file-plate"}
        onDragOver={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setOver(false);
          const file = event.dataTransfer.files?.[0];
          if (file && !busy) void read(file);
        }}
      >
        <p>
          Если параметры и штат уже есть в Excel или CSV, их можно не вбивать: загрузите файл или бросьте его сюда.
          Шаблон скачается с тем, что уже стоит на экране.
        </p>
        <span className="u-action-end">
          <label className={busy ? "u-btn u-btn-light u-file is-busy" : "u-btn u-btn-light u-file"}>
            <input type="file" accept=".xlsx,.csv" onChange={(event) => void upload(event)} disabled={busy} />
            {busy ? "Читаем файл..." : "Загрузить Excel или CSV"}
          </label>
          <Button kind="link" onClick={() => void template()}>
            Скачать шаблон
          </Button>
        </span>
      </div>
      {failure && <Alert>{failure}</Alert>}
      {applied && <Alert tone="note">{applied}. Их видно ниже, поправить можно как обычно.</Alert>}
      {result && report && (
        <div className="u-import">
          <p>
            Файл «{report.name}»: подставим <b className="mono">{result.applied}</b>
            {result.warnings > 0 && <>, из них с замечанием {result.warnings}</>}.
            {result.errors > 0 && <> Строк с ошибкой {result.errors}, их пропустим.</>}
            {clean > 0 && noted.length > 0 && <> Остальные {clean} без замечаний.</>}
          </p>
          {noted.length > 0 && (
            <Sheet
              columns={[
                { name: "Где", width: "130px" },
                { name: "Что" },
                { name: "В файле", width: "120px" },
                { name: "Что не так" },
              ]}
            >
              {noted.map((row) => (
                <SheetRow
                  key={`${row.sheet}-${row.row}-${row.field}`}
                  cells={[
                    <span className="mono">
                      {row.sheet}, {row.row ? `стр. ${row.row}` : "строки нет"}
                    </span>,
                    row.field || "без названия",
                    <span className="mono">{row.value}</span>,
                    <span className={row.status === "error" ? "u-import-bad" : "u-import-warn"}>
                      {row.status === "error" ? "Пропустим. " : ""}
                      {row.message}
                    </span>,
                  ]}
                />
              ))}
            </Sheet>
          )}
          <span className="u-action-end">
            <Button arrow disabled={result.applied === 0} onClick={apply}>
              Подставить {result.applied}
            </Button>
            <Button kind="link" onClick={() => setReport(null)}>
              Отмена
            </Button>
          </span>
        </div>
      )}
    </section>
  );
}
