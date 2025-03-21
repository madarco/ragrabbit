"use client";

import { Edit } from "@repo/design/base/icons";
import { Button } from "@repo/design/shadcn/button";
import { useState } from "react";
import { Indexed } from "@repo/db/schema";
import AddCrawlFormDialog from "./add-crawl-form-dialog";
import AddIndexForm, { EditIndexProps } from "./add-index-form-dialog";

interface EditButtonProps {
  index: Indexed;
  variant?: "outline" | "default" | "secondary" | "ghost" | "link" | "destructive";
  size?: "default" | "sm" | "lg" | "icon";
  className?: string;
}

export default function EditButton({ index, variant = "default", size = "default", className }: EditButtonProps) {
  const [showEditDialog, setShowEditDialog] = useState(false);

  const editIndexProps: EditIndexProps = {
    url: index.url,
    indexId: index.id,
    foundFromIndexId: index.foundFromIndexId,
    skip: index.skip,
  };

  return (
    <>
      {showEditDialog && index.doCrawl && (
        <AddCrawlFormDialog
          defaultValues={{
            url: index.url,
            isSitemap: index.isSitemap || false,
            scrapeOptions: index.scrapeOptions || {},
          }}
          indexId={index.id}
          open={showEditDialog}
          onOpenChange={setShowEditDialog}
        />
      )}
      {showEditDialog && !index.doCrawl && (
        <AddIndexForm {...editIndexProps} open={showEditDialog} onOpenChange={setShowEditDialog} />
      )}
      <Button variant={variant} size={size} onClick={() => setShowEditDialog(true)} className={className}>
        <Edit className="mr-2 h-4 w-4" />
        Edit
      </Button>
    </>
  );
}
