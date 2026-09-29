import { lazy, StrictMode, Suspense, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { homeOf, useMe } from "./ui/account";
import { CrashGuard } from "./ui/crash";

// Страницы: лендинг для гостя, вход, сам расчет, расчет по ссылке, кабинет с проектами, админка,
// какие данные храним и 404.
// Каждая грузится отдельно, чтобы стили мастера не попадали на лендинг и наоборот. Когда страниц
// станет больше, заменим это на React Router, как записано в docs/architecture.md.
// Лендинг для гостя. Выбрали вариант А, старый удален; прежний адрес /a ведет сюда
const Landing = lazy(() => import("./features/landing-a/LandingA").then((m) => ({ default: m.LandingA })));
const Login = lazy(() => import("./features/login/Login").then((m) => ({ default: m.Login })));
const App = lazy(() => import("./app/App").then((m) => ({ default: m.App })));
const Shared = lazy(() => import("./app/Shared").then((m) => ({ default: m.Shared })));
const Cabinet = lazy(() => import("./features/cabinet/Cabinet").then((m) => ({ default: m.Cabinet })));
// Главные экраны вошедшего и администратора, пока макет: /home и /admin/home
const Home = lazy(() => import("./features/home/Home").then((m) => ({ default: m.Home })));
const Dashboard = lazy(() => import("./features/admin/Dashboard").then((m) => ({ default: m.Dashboard })));
const Admin = lazy(() => import("./features/admin/Admin").then((m) => ({ default: m.Admin })));
const Privacy = lazy(() => import("./features/privacy/Privacy").then((m) => ({ default: m.Privacy })));
// Как мы считаем: методика картинками, на ее разделы ссылаются подвал мастера и главная вошедшего
const Method = lazy(() => import("./features/method/Method").then((m) => ({ default: m.Method })));
const NotFound = lazy(() => import("./features/notfound/NotFound").then((m) => ({ default: m.NotFound })));

function Front() {
  const me = useMe();
  useEffect(() => {
    if (me && me.role !== "guest") window.location.replace(homeOf(me.role));
  }, [me]);
  return <Landing />;
}

function Page() {
  const path = window.location.pathname;
  if (path.startsWith("/calc")) return <App />;
  if (path.startsWith("/share/")) return <Shared />;
  if (path.startsWith("/login")) return <Login />;
  if (path.startsWith("/projects")) return <Cabinet />;
  if (path === "/home") return <Home />;
  if (path === "/admin/home") return <Dashboard />;
  if (path.startsWith("/admin")) return <Admin />;
  if (path === "/privacy") return <Privacy />;
  if (path === "/method") return <Method />;
  // лендинг для гостя, вошедшего сразу ведем на его главную
  if (path === "/" || path === "/index.html") return <Front />;
  if (path === "/a" || path === "/a/") {
    window.location.replace("/");
    return null;
  }
  return <NotFound />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <CrashGuard>
      <Suspense fallback={null}>
        <Page />
      </Suspense>
    </CrashGuard>
  </StrictMode>,
);
