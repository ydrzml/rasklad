import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button, EmptyState, Hero, Mark, Panel, Wordmark } from "./index";
import { Pallet07, Sleeper06 } from "./robots";

/* Страница сломалась у нас в коде: вместо белого листа спокойный экран с кнопкой "Обновить".
   Введенное лежит в браузере (App.tsx, черновик), поэтому после обновления мастер откроется
   на том же шаге. Шапка своя, без запроса "кто вошел": если сломалось как раз там, экран
   ошибки не должен падать второй раз. */
function Crash() {
  return (
    <div className="u-page">
      <header className="u-head">
        <div className="u-wrap">
          <Panel>
            <div className="u-head-row is-alone">
              <a className="u-brand" href="/">
                <Mark /> <Wordmark />
              </a>
            </div>
          </Panel>
        </div>
      </header>
      <main className="u-main u-wrap">
        <Hero
          compact
          title="Что-то пошло не так"
          lead="Страница сломалась на нашей стороне, ваши данные тут ни при чем."
        />
        <EmptyState
          apart
          robot={<Pallet07 className="u-crash-bot" mood="oops" />}
          actions={
            <>
              <Button onClick={() => window.location.reload()}>Обновить страницу</Button>
              <a className="u-btn u-btn-link" href="/">
                На главную
              </a>
            </>
          }
        >
          Введенное не потерялось: расчет хранится в этом браузере, и после обновления откроется на том же месте.
          Сохраненные проекты лежат на сервере и тоже никуда не делись.
        </EmptyState>
      </main>
    </div>
  );
}

/* Граница ошибок React: ловит падение при отрисовке любой страницы и показывает Crash.
   Сюда же попадает кусок страницы, который не догрузился после обновления сервиса */
export class CrashGuard extends Component<{ children: ReactNode }, { broken: boolean }> {
  state = { broken: false };

  static getDerivedStateFromError() {
    return { broken: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Страница сломалась", error, info.componentStack);
  }

  render() {
    return this.state.broken ? <Crash /> : this.props.children;
  }
}

/* Сервер не ответил, когда страница открывалась: показывать нечего, но ввод цел.
   Говорим прямо, что не отвечает сервер, а не "что-то пошло не так" (docs/ux-flow.md) */
export function ServerDown({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <div className="u-server-down">
      <EmptyState
        title="Сервер не отвечает"
        robot={<Sleeper06 />}
        actions={<Button onClick={onRetry}>Повторить</Button>}
      >
        {what} Введенное не потерялось, оно в этом браузере. Обычно сервер поднимается за минуту.
      </EmptyState>
    </div>
  );
}
