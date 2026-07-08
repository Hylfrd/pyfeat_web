"""Local MySQL configuration for the experiment database.

Database configuration is defined here in code.
"""

MYSQL_HOST = "127.0.0.1"
MYSQL_PORT = 3306
MYSQL_DATABASE = "pyfeat_web"
MYSQL_USER = "root"
MYSQL_PASSWORD = ""
MYSQL_CHARSET = "utf8mb4"
MYSQL_COLLATION = "utf8mb4_unicode_ci"

MYSQL_POOL_SIZE = 10
MYSQL_MAX_OVERFLOW = 20
MYSQL_POOL_RECYCLE_SECONDS = 1800
