import { caseById } from "./demoCases";
import { CaseList } from "./CaseList";
import { CaseView } from "./CaseView";
import { NotFound } from "../notfound/NotFound";
import "../../app/app.css";
import "./cases.css";

/* Готовые разборы для гостя: /cases список, /cases/<id> один разбор. Без входа и без полей ввода.
   По адресу разбора, которого нет, та же страница 404, что у любого неизвестного адреса */
export function Cases() {
  const id = window.location.pathname.split("/")[2] ?? "";
  if (!id) return <CaseList />;
  // неизвестный разбор: общая страница 404 приложения, своей нет
  const one = caseById(id);
  return one ? <CaseView one={one} /> : <NotFound />;
}
