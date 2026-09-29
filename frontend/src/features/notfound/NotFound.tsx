import { AccountMenu, Button, EmptyState, Header, Hero } from "../../ui";
import { Scout04 } from "../../ui/robots";
import "./notfound.css";

// Страница, которой нет. Та же раскладка, что у пустого кабинета: объяснение и два выхода.
// Справа крупно 404, перед цифрами разведчик 04 стоит у оборванного маршрута.

export function NotFound() {
  return (
    <div className="u-page">
      <Header
        nav={
          <>
            <a className="u-wide-only" href="/calc?new=1">
              Новый расчет
            </a>
            <AccountMenu />
          </>
        }
      />
      <main className="u-main u-wrap">
        <Hero
          compact
          title="Такой страницы нет"
          lead={`По адресу ${window.location.pathname} у нас ничего не лежит.`}
        />
        <EmptyState
          apart
          robot={
            <div className="nf-art">
              <span className="nf-code mono">404</span>
              <Scout04 className="nf-bot" />
            </div>
          }
          actions={
            <>
              <Button arrow href="/">
                На главную
              </Button>
              <a className="u-btn u-btn-link" href="/projects">
                Мои проекты
              </a>
            </>
          }
        >
          Маршрут закончился раньше, чем страница нашлась. Возможно, ссылка устарела или в адресе опечатка. Расчеты и
          проекты никуда не делись, до них можно дойти с главной или из кабинета.
        </EmptyState>
      </main>
    </div>
  );
}
