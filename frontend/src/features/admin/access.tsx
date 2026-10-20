import { useEffect, useState } from "react";

import { account, type Me } from "../../api/projects";
import { EmptyState, Waiting } from "../../ui";
import { Keeper03 } from "../../ui/robots";

/* Кто открыл админку. Каталог и главную администратора видит только администратор: гостю и
   обычному пользователю один и тот же понятный экран, а не пустые "..." и ответы 403 */

export type Access = { state: "loading" } | { state: "guest" } | { state: "user"; me: Me } | { state: "admin"; me: Me };

export function useAccess(): Access {
  const [access, setAccess] = useState<Access>({ state: "loading" });
  useEffect(() => {
    account
      .me()
      .then((me) =>
        setAccess(
          me.role === "admin"
            ? { state: "admin", me }
            : me.role === "user"
              ? { state: "user", me }
              : { state: "guest" },
        ),
      )
      .catch(() => setAccess({ state: "guest" }));
  }, []);
  return access;
}

/* Экран вместо админки, пока не ясно, кто вошел, или если вошел не администратор. У администратора пусто */
export function NotAdmin({ access }: { access: Access }) {
  if (access.state === "loading") return <Waiting title="Проверяем, кто вошел" />;
  if (access.state === "guest")
    return (
      <EmptyState
        apart
        title="Админка открывается после входа"
        robot={<Keeper03 />}
        actions={
          <a className="u-btn u-btn-dark" href="/login">
            Войти
          </a>
        }
      >
        Каталог правит администратор. Войдите с аккаунтом администратора.
      </EmptyState>
    );
  if (access.state === "user")
    return (
      <EmptyState
        apart
        title="Сюда только администратору"
        robot={<Keeper03 />}
        actions={
          <a className="u-btn u-btn-dark" href="/projects">
            В мои проекты
          </a>
        }
      >
        Вы вошли как {access.me.email}. Каталог правит администратор, а подборку решений вы увидите в расчете.
      </EmptyState>
    );
  return null;
}
