import hashlib
import hmac
import secrets

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError, InvalidHashError
from cryptography.fernet import Fernet

from app.core.config import settings

_hasher = PasswordHasher()
_fernet = Fernet(settings.code_encryption_key.encode())


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password: str, hashed: str) -> bool:
    try:
        return _hasher.verify(hashed, password)
    except (VerifyMismatchError, InvalidHashError):
        return False


def digest(value: str) -> str:
    # keyed digest, same one Node uses so both backends find the same code
    return hmac.new(settings.code_digest_key.encode(), value.encode(), hashlib.sha256).hexdigest()


def new_session_token() -> str:
    return secrets.token_urlsafe(32)


def numeric_code(length: int) -> str:
    return "".join(str(secrets.randbelow(10)) for _ in range(length))


def new_patient_code() -> str:
    return numeric_code(12)


def new_access_code() -> str:
    return numeric_code(8)


def encrypt_code(code: str) -> str:
    return _fernet.encrypt(code.encode()).decode()


def decrypt_code(token: str) -> str:
    return _fernet.decrypt(token.encode()).decode()