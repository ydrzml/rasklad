import { createRoot } from "react-dom/client";

/* Подтверждение действия вместо системного window.confirm: те же шрифты и кнопки, что у сервиса,
   и понятные надписи на кнопках вместо «OK» и «Cancel». Работает на встроенном в браузер
   модальном окне <dialog>: фокус держится внутри, Esc отменяет, фон затемнен.

   const sure = await ask({ title: "Удалить проект?", text: "Вернуть не получится", yes: "Удалить" });
   Вызывается из обработчика нажатия, без состояния в компоненте. */

type Ask = { title: string; text?: string; yes?: string; no?: string; danger?: boolean };

export function ask({ title, text, yes = "Да", no = "Отмена", danger = false }: Ask): Promise<boolean> {
  return choose({
    title,
    text,
    no,
    options: [{ id: "yes", label: yes, kind: danger ? "stop" : "primary" }],
    // на опасном действии фокус на отмене: Enter по привычке не удалит
    focusNo: danger,
  }).then((answer) => answer === "yes");
}

/* То же окно с несколькими действиями: "Войти", "Зарегистрироваться" и "Не сейчас" у гостя,
   который сохраняет расчет. Отвечает id нажатого действия, отмена, Esc и щелчок мимо дают null.
   Действия справа налево по важности: главное последним, как в полосе действия */
export type ChooseOption = { id: string; label: string; kind?: "primary" | "ghost" | "stop" };

export function choose({
  title,
  text,
  options,
  no = "Отмена",
  focusNo = false,
}: {
  title: string;
  text?: string;
  options: ChooseOption[];
  no?: string;
  focusNo?: boolean;
}): Promise<string | null> {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    const close = (answer: string | null) => {
      root.unmount();
      host.remove();
      resolve(answer);
    };

    root.render(
      <dialog
        className="u-dialog"
        aria-labelledby="u-dialog-title"
        ref={(node) => {
          if (node && !node.open) node.showModal();
        }}
        onCancel={(event) => {
          event.preventDefault();
          close(null);
        }}
        onClick={(event) => {
          // щелчок по затемнению мимо окна отменяет, как Esc
          if (event.target === event.currentTarget) close(null);
        }}
      >
        <div className="u-dialog-body">
          <h2 id="u-dialog-title">{title}</h2>
          {text && <p>{text}</p>}
          <div className="u-dialog-actions">
            <button className="u-btn u-btn-ghost" autoFocus={focusNo} onClick={() => close(null)}>
              {no}
            </button>
            {options.map((one, index) => (
              <button
                key={one.id}
                className={`u-btn u-btn-${one.kind ?? "primary"}`}
                autoFocus={!focusNo && index === options.length - 1}
                onClick={() => close(one.id)}
              >
                {one.label}
              </button>
            ))}
          </div>
        </div>
      </dialog>,
    );
  });
}
