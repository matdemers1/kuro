-- Shared lists: Shows the owner recommends, readable by link without signing in.
CREATE TABLE "share_list" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "intro" TEXT,
    "token" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "share_list_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "share_list_token_key" ON "share_list"("token");

CREATE TABLE "share_list_item" (
    "list_id" UUID NOT NULL,
    "show_key" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "note" TEXT,

    CONSTRAINT "share_list_item_pkey" PRIMARY KEY ("list_id","show_key"),
    CONSTRAINT "share_list_item_list_id_fkey" FOREIGN KEY ("list_id") REFERENCES "share_list"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "share_list_item_list_id_position_idx" ON "share_list_item"("list_id", "position");
