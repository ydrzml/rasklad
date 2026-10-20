"""Письма сервиса: ссылка на новый пароль и код для регистрации.

Почта задается переменными SMTP_* (.env.example). Если SMTP_HOST пустой, письмо никуда не уходит,
а ложится в служебную таблицу "Письма без отправки": так сервис работает и без почты, а администратор
может сам передать человеку ссылку. Пароль от ящика нигде, кроме настроек, не хранится и в журнал не пишется."""

import logging
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formataddr, make_msgid
from html import escape

from email_validator import EmailNotValidError, EmailUndeliverableError, validate_email
from sqlalchemy.orm import Session

from app.settings import settings
from app.storage.models import MailOutbox

log = logging.getLogger("app")

SUBJECT = "Расклад: ссылка для нового пароля"
SMTP_TIMEOUT_SECONDS = 20
DNS_TIMEOUT_SECONDS = 5
# Порт 465 сразу шифрованный, на остальных (587) шифрование включаем командой STARTTLS
SSL_PORT = 465
BLUE = "#0b4fa8"
INK = "#0d141b"
INK_SOFT = "#55636f"


def configured() -> bool:
    return bool(settings.smtp_host)


def sender() -> str:
    return settings.mail_from or settings.smtp_user


FOOTER = "Расклад, подбор роботов для склада и расчет окупаемости"
P = "margin:0 0 16px;font-size:16px;line-height:1.5"
P_SOFT = f"margin:0 0 12px;font-size:14px;line-height:1.5;color:{INK_SOFT}"


def _letter(to: str, subject: str, text: str, body: str) -> EmailMessage:
    """Письмо текстом и в HTML: белая карточка на сером, как экран входа. body - абзацы HTML"""
    site = settings.site_url.rstrip("/")
    html = f"""<!doctype html>
<html lang="ru"><body style="margin:0;padding:24px;background:#f6f8fa;font-family:Arial,sans-serif;color:{INK}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"
 style="max-width:480px;background:#ffffff;border-radius:16px;padding:28px">
<tr><td>
<p style="margin:0 0 20px;font-size:20px;font-weight:bold">Расклад</p>
<p style="{P}">Здравствуйте!</p>
{body}
</td></tr></table>
<p style="margin:16px 0 0;font-size:13px;color:{INK_SOFT}">{FOOTER}<br>
<a href="{escape(site)}" style="color:{INK_SOFT}">{escape(site)}</a></p>
</td></tr></table>
</body></html>
"""
    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = formataddr(("Расклад", sender()))
    message["To"] = to
    message["Message-ID"] = make_msgid(domain=sender().rpartition("@")[2] or None)
    message.set_content(f"Здравствуйте!\n\n{text}\n\n{FOOTER}\n{site}\n")
    message.add_alternative(html, subtype="html")
    return message


def reset_letter(to: str, link: str) -> EmailMessage:
    minutes = settings.reset_minutes
    text = (
        f"Для почты {to} попросили сменить пароль в Раскладе.\n\n"
        "Чтобы задать новый пароль, откройте ссылку:\n"
        f"{link}\n\n"
        f"Ссылка работает {minutes} минут и только один раз.\n\n"
        "Если пароль меняли не вы, просто удалите письмо: без ссылки пароль никто не сменит, "
        "а прежний продолжит работать."
    )
    body = f"""<p style="{P}">Для почты {escape(to)} попросили сменить пароль.
Чтобы задать новый, нажмите на кнопку.</p>
<p style="margin:0 0 20px"><a href="{escape(link)}"
 style="display:inline-block;padding:12px 24px;border-radius:999px;background:{BLUE};color:#ffffff;
 font-size:16px;text-decoration:none">Задать новый пароль</a></p>
<p style="{P_SOFT}">Ссылка работает {minutes} минут и только один раз. Если кнопка не нажимается,
скопируйте адрес в браузер:<br>
<a href="{escape(link)}" style="color:{BLUE};word-break:break-all">{escape(link)}</a></p>
<p style="{P_SOFT}">Если пароль меняли не вы, просто удалите письмо: без ссылки пароль никто не сменит,
а прежний продолжит работать.</p>"""
    return _letter(to, SUBJECT, text, body)


def signup_letter(to: str, code: str, minutes: int) -> EmailMessage:
    text = (
        f"Код для регистрации в Раскладе: {code}\n\n"
        f"Введите его на странице регистрации. Код работает {minutes} минут.\n\n"
        "Если вы не регистрировались, просто удалите письмо: без кода аккаунт не появится."
    )
    body = f"""<p style="{P}">Код для регистрации в Раскладе:</p>
<p style="margin:0 0 20px;font-size:32px;font-weight:bold;letter-spacing:6px;color:{BLUE}">{escape(code)}</p>
<p style="{P_SOFT}">Введите его на странице регистрации. Код работает {minutes} минут.</p>
<p style="{P_SOFT}">Если вы не регистрировались, просто удалите письмо: без кода аккаунт не появится.</p>"""
    return _letter(to, f"Расклад: код {code} для регистрации", text, body)


def domain_accepts_mail(email: str) -> bool:
    """Есть ли у домена почты почтовый сервер. Опечатку вроде gmial.con видно сразу, письмо туда не шлем.
    Если проверка не успела или сеть недоступна, считаем, что почта есть: лучше письмо, чем отказ"""
    try:
        validate_email(email, check_deliverability=True, timeout=DNS_TIMEOUT_SECONDS)
    except EmailUndeliverableError:
        return False
    except EmailNotValidError:
        return True
    return True


def deliver(message: EmailMessage) -> None:
    """Отправляет письмо через SMTP. Ошибку не прячем: ее ловят send_reset и регистрация."""
    context = ssl.create_default_context()
    if settings.smtp_port == SSL_PORT:
        connection: smtplib.SMTP = smtplib.SMTP_SSL(
            settings.smtp_host, settings.smtp_port, timeout=SMTP_TIMEOUT_SECONDS, context=context
        )
    else:
        connection = smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=SMTP_TIMEOUT_SECONDS)
        connection.starttls(context=context)
    with connection:
        if settings.smtp_user:
            connection.login(settings.smtp_user, settings.smtp_password)
        connection.send_message(message)


def keep_unsent(session: Session, to: str, link: str) -> None:
    """Почта не настроена: письмо ложится в служебную таблицу, ссылку оттуда передает администратор."""
    session.add(MailOutbox(to_email=to, subject=SUBJECT, link=link))
    session.commit()
    log.info('Почта не настроена, письмо со ссылкой на новый пароль в таблице "Письма без отправки"')


def send_reset(to: str, link: str) -> None:
    """Зовется в фоне, после ответа на запрос: иначе по времени ответа было бы видно, есть ли такая почта.
    Не ушло: пишем причину в журнал сервера, без адреса и ссылки. Письма нет, человек попросит еще раз."""
    try:
        deliver(reset_letter(to, link))
    except (smtplib.SMTPException, OSError) as error:
        # Текст ошибки не пишем: в отказе сервера бывает адрес получателя
        code = getattr(error, "smtp_code", "")
        log.error("Письмо со ссылкой на новый пароль не ушло: %s %s", type(error).__name__, code)
