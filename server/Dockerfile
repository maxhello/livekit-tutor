# syntax=docker/dockerfile:1
# 历史后端镜像:uv + uvicorn,单阶段(纯 Python 无编译依赖)

FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim

ENV PYTHONUNBUFFERED=1
WORKDIR /app

# 先拷依赖文件,利用层缓存
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev

COPY main.py models.py auth.py ./

# 非 root 运行
ARG UID=10001
RUN adduser --disabled-password --gecos "" --home /app --shell /sbin/nologin --uid "${UID}" appuser
USER appuser

# 运行时直接调 venv 里的 uvicorn:不再经过 uv(避免它往 /app/.cache 写缓存,
# 那目录归 root,appuser 没有写权限)
ENV PATH="/app/.venv/bin:$PATH"
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
