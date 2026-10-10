"""测试环境:在 import main 之前定好环境变量,并把 server/ 根目录挂进 sys.path。"""

import os
import sys
from pathlib import Path

os.environ.setdefault("JWT_SECRET", "test-secret-0123456789abcdef0123456789abcdef")
os.environ.setdefault("DATABASE_URL", "sqlite://")
os.environ.setdefault("GITHUB_ALLOWLIST", "maxhello,alice")

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
