"""数据库模型与引擎(SQLAlchemy;生产 PostgreSQL,测试 sqlite 内存库)。"""

import os
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import JSON, DateTime, ForeignKey, create_engine
from sqlalchemy.orm import (
    DeclarativeBase,
    Mapped,
    mapped_column,
    relationship,
    sessionmaker,
)

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./tutor.db")


class Base(DeclarativeBase):
    pass


class UserRow(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    github_login: Mapped[str] = mapped_column(unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(
        default=lambda: datetime.now(timezone.utc)
    )


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class SessionRow(Base):
    __tablename__ = "sessions"

    id: Mapped[int] = mapped_column(primary_key=True)  # 前端用作会话 id
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    # 起止时间都由服务器生成:领房间 token 时建会话,第一次保存时记结束
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow
    )
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    scenario: Mapped[str] = mapped_column(default="")
    created_at: Mapped[datetime] = mapped_column(
        default=lambda: datetime.now(timezone.utc)
    )

    messages: Mapped[list["MessageRow"]] = relationship(
        back_populates="session",
        cascade="all, delete-orphan",
        order_by="MessageRow.idx",
    )
    corrections: Mapped[list["CorrectionRow"]] = relationship(
        back_populates="session",
        cascade="all, delete-orphan",
        order_by="CorrectionRow.idx",
    )


class MessageRow(Base):
    __tablename__ = "messages"

    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("sessions.id"), index=True)
    idx: Mapped[int]
    role: Mapped[str]  # 'emma' | 'me'
    text: Mapped[str]

    session: Mapped[SessionRow] = relationship(back_populates="messages")


class CorrectionRow(Base):
    __tablename__ = "corrections"

    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("sessions.id"), index=True)
    idx: Mapped[int]
    original: Mapped[str]
    corrected: Mapped[str]
    kind: Mapped[str]  # 'grammar' | 'word' | 'pronunciation'
    point: Mapped[str]  # 中文语法点解释
    words: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    at_ms: Mapped[int] = mapped_column(default=0)  # 距会话开始毫秒

    session: Mapped[SessionRow] = relationship(back_populates="corrections")


if DATABASE_URL.startswith("sqlite"):
    from sqlalchemy.pool import StaticPool

    _sqlite_kwargs: dict[str, Any] = {"connect_args": {"check_same_thread": False}}
    if DATABASE_URL == "sqlite://":
        # 内存库:全线程共享一个连接,否则建表对别的线程不可见(测试用)
        _sqlite_kwargs["poolclass"] = StaticPool
    engine = create_engine(DATABASE_URL, **_sqlite_kwargs)
else:
    # Neon(serverless PG)会挂起空闲计算并掐掉长连接:
    # 小连接池 + 空闲回收 + pre_ping,避免陈旧连接报错
    engine = create_engine(
        DATABASE_URL,
        pool_pre_ping=True,
        pool_size=3,
        max_overflow=0,
        pool_recycle=300,
    )
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)


def get_db() -> Any:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
