'use client'

import { Controller, useForm, useWatch } from 'react-hook-form'
import { useEffect, useState, useRef, useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useCreateNote, useUpdateNote, useNote } from '@/lib/hooks/use-notes'
import { QUERY_KEYS } from '@/lib/api/query-client'
import { MarkdownEditor } from '@/components/ui/markdown-editor'
import { InlineEdit } from '@/components/common/InlineEdit'
import { cn } from "@/lib/utils";

const createNoteSchema = z.object({
  title: z.string().optional(),
  content: z.string().min(1, 'Content is required'),
})

type CreateNoteFormData = z.infer<typeof createNoteSchema>

interface NoteEditorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  notebookId: string
  note?: { id: string; title: string | null; content: string | null }
}

export function NoteEditorDialog({ open, onOpenChange, notebookId, note }: NoteEditorDialogProps) {
  const createNote = useCreateNote()
  const updateNote = useUpdateNote()
  const queryClient = useQueryClient()
  const isEditing = Boolean(note)

  // Ensure note ID has 'note:' prefix for API calls
  const noteIdWithPrefix = note?.id
    ? (note.id.includes(':') ? note.id : `note:${note.id}`)
    : ''

  const { data: fetchedNote, isLoading: noteLoading } = useNote(noteIdWithPrefix, { enabled: open && !!note?.id })
  const isSaving = isEditing ? updateNote.isPending : createNote.isPending
  const {
    handleSubmit,
    control,
    formState: { errors },
    reset,
    setValue,
  } = useForm<CreateNoteFormData>({
    resolver: zodResolver(createNoteSchema),
    defaultValues: {
      title: '',
      content: '',
    },
  })

  const watchTitle = useWatch({ control, name: 'title' })
  const watchedContent = useWatch({ control, name: 'content' })

  const [isEditorFullscreen, setIsEditorFullscreen] = useState(false)
  // Keep track of a note id created by autosave (for new notes)
  const [savedNoteId, setSavedNoteId] = useState<string | null>(note?.id ?? null)
  // track last successful autosave timestamp (ISO string)
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null)
  // refs to manage autosave timer and initial load flag
  const autosaveTimerRef = useRef<number | null>(null)
  const initialLoadRef = useRef(true)
  // refs to hold the last saved title/content for change detection
  const lastSavedContentRef = useRef<string | null>(null)
  const lastSavedTitleRef = useRef<string | null>(null)

  const getCurrentNoteId = useCallback(() => {
    return savedNoteId ?? note?.id ?? ''
  }, [savedNoteId, note])

  // compute id with API prefix if needed
  const currentNoteIdWithPrefix = (() => {
    const id = getCurrentNoteId()
    return id ? (id.includes(':') ? id : `note:${id}`) : ''
  })()

  useEffect(() => {
    if (!open) {
      reset({ title: '', content: '' })
      return
    }

    const source = fetchedNote ?? note
    const title = source?.title ?? ''
    const content = source?.content ?? ''

    reset({ title, content })
    // reset autosave initial load guard so we don't immediately autosave on open
    initialLoadRef.current = true
    // initialize last-saved refs to the current loaded note so we only autosave on real changes
    lastSavedContentRef.current = content
    lastSavedTitleRef.current = title
    // do not set lastSavedAt here; only mark when an actual save occurs
  }, [open, note, fetchedNote, reset])

  useEffect(() => {
    if (!open) return

    const observer = new MutationObserver(() => {
      setIsEditorFullscreen(!!document.querySelector('.w-md-editor-fullscreen'))
    })
    observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [open])

  const onSubmit = async (data: CreateNoteFormData) => {
    if (note) {
      await updateNote.mutateAsync({
        id: noteIdWithPrefix,
        data: {
          title: data.title || undefined,
          content: data.content,
        },
      })
      // Only invalidate notebook-specific queries if we have a notebookId
      if (notebookId) {
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.notes(notebookId) })
      }
      // mark saved time and update last-saved refs
      setLastSavedAt(new Date().toISOString())
      lastSavedContentRef.current = data.content
      lastSavedTitleRef.current = data.title ?? ''
    } else {
      // Creating a note requires a notebookId
      if (!notebookId) {
        console.error('Cannot create note without notebook_id')
        return
      }
      const created = await createNote.mutateAsync({
        title: data.title || undefined,
        content: data.content,
        note_type: 'human',
        notebook_id: notebookId,
      })
      // If created, store id for subsequent autosaves
      if (created?.id) {
        const createdId = created.id.includes(':') ? created.id.split(':', 2)[1] ?? created.id : created.id
        setSavedNoteId(createdId)
      }
      // mark saved time and update last-saved refs
      setLastSavedAt(new Date().toISOString())
      lastSavedContentRef.current = data.content
      lastSavedTitleRef.current = data.title ?? ''
    }
    reset()
    onOpenChange(false)
  }

  const handleClose = () => {
    reset()
    setIsEditorFullscreen(false)
    // clear saved metadata when closing
    setLastSavedAt(null)
    setSavedNoteId(note?.id ?? null)
    onOpenChange(false)
  }

  // Autosave effect: only save when content/title changed and at most every 30s
  useEffect(() => {
    if (!open) return

    // do not autosave while loading the note or while a save is in progress
    if (noteLoading || createNote.isPending || updateNote.isPending) return

    // Skip autosave on the very first load after opening/resetting the form
    if (initialLoadRef.current) {
      // mark initial load as finished so typing triggers autosave afterwards
      initialLoadRef.current = false
      return
    }

    const currentTitle = watchTitle ?? ''
    const currentContent = watchedContent ?? ''
    const lastTitle = lastSavedTitleRef.current ?? ''
    const lastContent = lastSavedContentRef.current ?? ''

    // If nothing changed compared to the last saved state, don't schedule a save
    if (currentTitle === lastTitle && currentContent === lastContent) {
      return
    }

    // clear any existing timer
    if (autosaveTimerRef.current) {
      window.clearTimeout(autosaveTimerRef.current)
      autosaveTimerRef.current = null
    }

    // Autosave interval: 30 seconds
    autosaveTimerRef.current = window.setTimeout(async () => {
      try {
        const title = currentTitle
        const content = currentContent

        // If we have an existing note id (prop or created by autosave), update it
        const currentId = getCurrentNoteId()
        if (currentId) {
          const idWithPrefix = currentId.includes(':') ? currentId : `note:${currentId}`
          await updateNote.mutateAsync({
            id: idWithPrefix,
            data: {
              title: title || undefined,
              content,
            },
          })
          // record successful save time and update refs
          setLastSavedAt(new Date().toISOString())
          lastSavedContentRef.current = content
          lastSavedTitleRef.current = title
        } else {
          // For new notes, only autosave if there's content (schema requires non-empty)
          if (!notebookId) return
          if (!content || content.length < 1) return

          const created = await createNote.mutateAsync({
            title: title || undefined,
            content,
            note_type: 'human',
            notebook_id: notebookId,
          })

          // If create returns an id, store it (strip prefix if present) and update refs
          if (created?.id) {
            const createdId = created.id.includes(':') ? created.id.split(':', 2)[1] ?? created.id : created.id
            setSavedNoteId(createdId)
            setLastSavedAt(new Date().toISOString())
            lastSavedContentRef.current = content
            lastSavedTitleRef.current = title
          }
        }
      } catch (e) {
        // swallow errors for autosave (optionally surface a toast later)
        // console.error('Autosave failed', e)
      } finally {
        autosaveTimerRef.current = null
      }
    }, 30000)

    return () => {
      if (autosaveTimerRef.current) {
        window.clearTimeout(autosaveTimerRef.current)
        autosaveTimerRef.current = null
      }
    }
  // intentionally include relevant deps; do not include forms/control object itself
  }, [open, watchTitle, watchedContent, noteLoading, createNote, updateNote, notebookId, getCurrentNoteId, createNote.isPending, updateNote.isPending])

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className={cn(
          // allow the dialog to scroll when content is tall
          "sm:max-w-3xl w-full max-h-[90vh] overflow-auto p-0",
          isEditorFullscreen && "!max-w-screen !max-h-screen border-none w-screen h-screen"
      )}>
        <DialogTitle className="sr-only">
          {isEditing ? 'Edit note' : 'Create note'}
        </DialogTitle>
        <form onSubmit={handleSubmit(onSubmit)} className="flex h-full flex-col">
          {isEditing && noteLoading ? (
            <div className="flex-1 flex items-center justify-center py-10">
              <span className="text-sm text-muted-foreground">Loading note…</span>
            </div>
          ) : (
            <>
              <div className="border-b px-6 py-4">
                <InlineEdit
                  value={watchTitle ?? ''}
                  onSave={(value) => setValue('title', value || '')}
                  placeholder="Add a title..."
                  emptyText="Untitled Note"
                  className="text-xl font-semibold"
                  inputClassName="text-xl font-semibold"
                />
              </div>

              <div className={cn(
                  "flex-1 overflow-y-auto",
                  !isEditorFullscreen && "px-6 py-4")
              }>
                <Controller
                  control={control}
                  name="content"
                  render={({ field }) => (
                    <MarkdownEditor
                      key={note?.id ?? 'new'}
                      value={field.value}
                      onChange={field.onChange}
                      placeholder="Write your note content here..."
                      className={cn(
                          "w-full h-full min-h-[420px] [&_.w-md-editor]:!static [&_.w-md-editor]:!w-full [&_.w-md-editor]:!h-full",
                          !isEditorFullscreen && "rounded-md border"
                      )}
                    />
                  )}
                />
                {errors.content && (
                  <p className="text-sm text-red-600 mt-1">{errors.content.message}</p>
                )}
              </div>
            </>
          )}

          <div className="border-t px-6 py-4 flex items-center justify-between gap-2">
            <div className="text-sm text-muted-foreground">
              { (isSaving || createNote.isPending || updateNote.isPending) ? (
                'Saving...'
              ) : lastSavedAt ? (
                <>Autosaved {new Date(lastSavedAt).toLocaleString()}</>
              ) : null }
            </div>
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" onClick={handleClose}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={isSaving || (isEditing && noteLoading)}
              >
                {isSaving
                  ? isEditing ? 'Saving...' : 'Creating...'
                  : isEditing
                    ? 'Save Note'
                    : 'Create Note'}
              </Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
