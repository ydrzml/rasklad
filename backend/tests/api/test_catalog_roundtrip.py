"""Сквозной путь каталога с чистой базы: выгрузка в формате организатора как есть и та же выгрузка
с нашими характеристиками. Файл организатора лежит только в закрытом репозитории, поэтому "голую"
выгрузку делаем из нашей: те же колонки организатора, наши справа отрезаны."""

import csv
import io

import pytest

from app.db import get_session
from app.main import app
from app.services import catalog_export, catalog_import, catalog_uses, selection
from app.services.catalog_import import ORGANIZER_COLUMNS

BASE = "/api/admin/catalog"
H1500 = "5760e938-9a43-45a7-b8e8-f4f2e6383930"
RONAVI_M = "dcfd9975-81eb-49b5-a422-827a720ba582"


def session():
    return next(app.dependency_overrides[get_session]())


@pytest.fixture(scope="module")
def full_file():
    """Наша выгрузка: база как после первого запуска, все колонки."""
    from tests.conftest import memory_database

    _, make = memory_database()
    s = make()
    catalog_import.seed_team_catalog(s)
    catalog_uses.seed_uses(s)
    return catalog_export.export(s)


def organizer_only(content: bytes) -> bytes:
    rows = list(csv.DictReader(io.StringIO(content.decode("utf-8-sig")), delimiter=";"))
    for row in rows:
        # у организатора тип заполнен у всех, в наших данных для склада его нет: все это роботы
        row["тип"] = row["тип"] or "brs"
    out = io.StringIO()
    writer = csv.DictWriter(out, fieldnames=list(ORGANIZER_COLUMNS), delimiter=";", extrasaction="ignore")
    writer.writeheader()
    writer.writerows(rows)
    return out.getvalue().encode("utf-8")


@pytest.fixture
def admin(db_client, monkeypatch):
    """Админ на пустой базе, подбор смотрит в нее же."""
    db_client.post("/api/auth/demo", json={"role": "admin"})
    monkeypatch.setattr(selection, "sessions", session)
    selection.forget()
    yield db_client
    selection.forget()


def upload(client, content: bytes):
    response = client.post(f"{BASE}/import", files={"file": ("katalog.csv", content, "text/csv")})
    assert response.status_code == 200, response.text
    return response.json()


def fitting(client, operation):
    found = client.get("/api/catalog/solutions", params={"operation": operation}).json()
    return {s["id"]: s for s in found if s["status"] != "excluded"}


def test_organizer_file_as_is_gives_solutions_with_objects_and_tasks(admin, full_file):
    report = upload(admin, organizer_only(full_file))
    assert report["added"] == 31 and not report["errors"] and report["ours"] == 0

    # в админке видно, где решение работает и что делает: наш список подтвержден сразу
    card = admin.get(f"{BASE}/{H1500}").json()
    assert card["facilities"] == ["warehouse"]
    assert [(u["facility_label"], u["label"], u["status"]) for u in card["uses"]] == [
        ("Склад", "Перевозка паллет", "confirmed"),
        ("Склад", "Отбор товара", "confirmed"),  # кандидат с пометкой «требует проверки»
    ]
    assert not card["specs"]  # характеристик у организатора нет

    # в подборе решения есть, без характеристик они "требуют проверки", а не исключены
    pallets = fitting(admin, "pallet_transport")
    assert H1500 in pallets and pallets[H1500]["status"] == "needs_check" and pallets[H1500]["can_calculate"]
    assert RONAVI_M in fitting(admin, "piece_picking")

    # робот из модели считается
    preview = admin.post("/api/calculations/preview", json={}).json()
    assert preview["feasible"] and preview["scenarios"][1]["capex_rub"]["hardware"] > 0


def test_rule_suggestions_wait_for_admin_and_then_go_to_selection(admin, full_file):
    upload(admin, organizer_only(full_file))
    s = session()
    solution = s.get(catalog_import.Solution, RONAVI_M)
    # решение без подтвержденной задачи со сценарием организатора, как у позиций не из нашего списка
    for use in list(solution.uses):
        solution.uses.remove(use)
    solution.scenario = "Сборка товаров"
    s.commit()
    catalog_uses.suggest(s, [solution])
    s.commit()
    card = admin.get(f"{BASE}/{RONAVI_M}").json()
    suggested = [u for u in card["uses"] if u["status"] == "suggested"]
    assert suggested and card["to_check"] == len(suggested)
    assert RONAVI_M not in fitting(admin, "piece_picking")

    first = suggested[0]
    admin.put(f"{BASE}/{RONAVI_M}/uses/{first['facility']}/{first['operation']}", json={"status": "confirmed"})
    listed = admin.get("/api/catalog/solutions", params={"operation": first["operation"]}).json()
    assert any(s["id"] == RONAVI_M for s in listed)


def test_our_file_restores_the_catalog_and_second_upload_changes_nothing(admin, full_file):
    report = upload(admin, full_file)
    assert report["added"] == 31 and not report["errors"] and report["ours"] > 0
    card = admin.get(f"{BASE}/{H1500}").json()
    payload = next(s for s in card["specs"] if s["field"] == "payload_kg")
    assert (payload["value"], payload["rating"]) == ("1500", "A")
    assert card["process"] == "Внутрипроизводственная логистика"
    pallets = fitting(admin, "pallet_transport")
    assert pallets[H1500]["status"] == "recommended"

    # выгрузка из этой базы совпадает с загруженным файлом, повторная загрузка ничего не меняет
    exported = admin.get(f"{BASE}/export")
    assert exported.status_code == 200 and exported.headers["content-type"].startswith("text/csv")
    assert exported.content == full_file
    again = upload(admin, full_file)
    assert again["added"] == again["updated"] == again["ours"] == 0


def test_our_columns_fill_the_gaps_of_organizer_file(admin, full_file):
    """Сначала выгрузка организатора как есть, потом наша поверх: характеристики появляются."""
    upload(admin, organizer_only(full_file))
    assert fitting(admin, "pallet_transport")[H1500]["status"] == "needs_check"
    report = upload(admin, full_file)
    assert report["added"] == 0 and report["ours"] > 0
    assert fitting(admin, "pallet_transport")[H1500]["status"] == "recommended"
    log = admin.get(f"{BASE}/changes", params={"limit": 500}).json()
    assert any(c["action"] == "file_edit" and c["solution_id"] == H1500 for c in log)


def test_bad_value_in_our_columns_is_reported_by_row(admin, full_file):
    text = full_file.decode("utf-8-sig")
    header, first, *rest = text.split("\n")
    columns = header.split(";")
    cells = next(csv.reader([first], delimiter=";"))
    cells[columns.index("Грузоподъемность: оценка")] = "Q"
    out = io.StringIO()
    csv.writer(out, delimiter=";", lineterminator="\n").writerow(cells)
    broken = "\n".join([header, out.getvalue().rstrip("\n"), *rest]).encode("utf-8")
    report = upload(admin, broken)
    assert report["added"] == 30
    assert report["errors"][0]["row"] == 2 and "оценка" in report["errors"][0]["message"]


def test_export_is_for_admin_only(db_client):
    assert db_client.get(f"{BASE}/export").status_code == 401


def test_text_that_looks_like_a_formula_is_written_as_text_and_comes_back(admin, full_file):
    upload(admin, full_file)
    name = '=HYPERLINK("http://example.com","x")'
    source = "@SUM(1+1)"
    assert admin.patch(f"{BASE}/{H1500}", json={"name": name, "company": "-ООО Тест"}).status_code == 200
    card = admin.get(f"{BASE}/{H1500}").json()
    spec_id = next(s["id"] for s in card["specs"] if s["field"] == "payload_kg")
    admin.patch(f"{BASE}/{H1500}/specs/{spec_id}", json={"source": source, "value": "-20"})

    exported = admin.get(f"{BASE}/export").content
    rows = list(csv.DictReader(io.StringIO(exported.decode("utf-8-sig")), delimiter=";"))
    row = next(r for r in rows if r["id"] == H1500)
    assert row["Название"] == "'" + name and row["компания"] == "'-ООО Тест"
    assert row["Грузоподъемность: источник"] == "'" + source
    assert row["Грузоподъемность, кг"] == "-20"  # число остается числом
    assert all(
        not v.startswith(catalog_export.DANGER) or catalog_export.NUMBER.fullmatch(v)
        for r in rows
        for v in r.values()
        if v
    )

    # в пустую базу файл приносит тот же текст, без апострофа
    session().query(catalog_import.Solution).delete()
    session().commit()
    report = upload(admin, exported)
    assert not report["errors"]
    back = admin.get(f"{BASE}/{H1500}").json()
    assert (back["name"], back["company"]) == (name, "-ООО Тест")
    assert next(s["source"] for s in back["specs"] if s["field"] == "payload_kg") == source


NEW = "11111111-2222-3333-4444-555555555555"


def with_new_position(content: bytes) -> bytes:
    """Выгрузка организатора: наши позиции и одна чужая со сценарием, которого нет в нашем списке."""
    extra = f"{NEW};Тележка из выгрузки;brs;operation;ООО Пример;;Мобильные роботы;AMR;Сборка товаров;;7;;;;1000000\n"
    return content + extra.encode("utf-8")


def test_first_start_loads_organizer_file_once_and_keeps_selection(db_client, monkeypatch, tmp_path, full_file):
    """prepare_database: наш каталог, потом выгрузка организатора файлом. Подбор склада
    не меняется: новые позиции приходят предложениями и ждут администратора."""
    from app.services.catalog_photos import seed_photos

    path = tmp_path / "catalog_export_v4.csv"
    path.write_bytes(with_new_position(organizer_only(full_file)))
    monkeypatch.setattr(catalog_import, "organizer_file", lambda: path)
    monkeypatch.setattr(selection, "sessions", session)
    s = session()
    catalog_import.seed_team_catalog(s)
    seed_photos(s)
    catalog_uses.seed_uses(s)
    selection.forget()
    before = {op: selection.solutions("warehouse", op) for op in ("pallet_transport", "piece_picking", "cleaning")}

    assert catalog_import.seed_organizer_catalog(session()) == 1
    assert catalog_import.seed_organizer_catalog(session()) == 0  # второй запуск ничего не добавляет
    selection.forget()
    after = {op: selection.solutions("warehouse", op) for op in before}
    assert after == before

    new = session().get(catalog_import.Solution, NEW)
    assert [(u.facility, u.operation, u.status) for u in new.uses] == [("warehouse", "piece_picking", "suggested")]
    ours = session().get(catalog_import.Solution, H1500)
    assert ours.specs and ours.description == ""  # наши характеристики на месте
    selection.forget()


def test_without_organizer_file_first_start_keeps_our_catalog(db_client, monkeypatch, tmp_path):
    monkeypatch.setattr(catalog_import, "organizer_file", lambda: tmp_path / "нет.csv")
    assert catalog_import.seed_organizer_catalog(session()) == 0


@pytest.mark.skipif(not catalog_import.organizer_file().exists(), reason="выгрузки организатора нет в этой копии")
def test_bundled_organizer_file_gives_190_positions(db_client):
    s = session()
    catalog_import.seed_team_catalog(s)
    catalog_uses.seed_uses(s)
    assert catalog_import.seed_organizer_catalog(session()) == 159
    assert session().query(catalog_import.Solution).count() == 190


def test_catalog_tree_goes_from_industry_to_product(admin, full_file):
    upload(admin, with_new_position(organizer_only(full_file)))
    tree = admin.get(f"{BASE}/tree").json()
    names = [node["name"] for node in tree]
    assert names[-1] == "Отрасль не указана"
    # наша позиция без отрасли: склад -> перевозка паллет -> тип -> решение
    branch = tree[-1]
    warehouse = next(n for n in branch["children"] if n["name"] == "Склад")
    pallets = next(n for n in warehouse["children"] if n["name"] == "Перевозка паллет")
    leaves = [leaf for kind in pallets["children"] for leaf in kind["children"]]
    assert any(leaf["solution_id"] == H1500 for leaf in leaves)
    assert pallets["count"] == len({leaf["solution_id"] for leaf in leaves})
    # предложенная задача тоже видна, пока ее не отклонили
    picking = next(n for n in warehouse["children"] if n["name"] == "Отбор товара")
    assert any(leaf["solution_id"] == NEW for kind in picking["children"] for leaf in kind["children"])
