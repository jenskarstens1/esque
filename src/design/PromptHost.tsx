import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Dialog } from './Dialog'
import { Button } from './Controls'
import { settleAsk, snapshot, subscribe, type Ask } from './prompt'

export function PromptHost() {
  const asks = useSyncExternalStore(subscribe, snapshot)
  const ask = asks[0]
  if (!ask) return null
  return <AskDialog key={ask.id} ask={ask} />
}

function AskDialog({ ask }: { ask: Ask }) {
  const [value, setValue] = useState(ask.initial)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    // Selecting the existing name means a rename is one keystroke, and keeping
    // it means the user only has to press Return.
    const t = window.setTimeout(() => input.current?.select(), 20)
    return () => window.clearTimeout(t)
  }, [])

  const settle = (v: string | null) => settleAsk(ask.id, v)

  const text = ask.kind === 'text'
  const trimmed = value.trim()
  const submit = () => settle(text ? trimmed : '')

  return (
    <Dialog
      open
      onClose={() => settle(null)}
      title={ask.title}
      description={ask.description}
      width={400}
      scrollable={false}
      bodyClassName={text ? 'px-5 pb-1' : 'hidden'}
      footer={
        <>
          <Button onClick={() => settle(null)}>Cancel</Button>
          <Button
            variant={ask.danger ? 'destructive' : 'primary'}
            disabled={text && !trimmed}
            onClick={submit}
          >
            {ask.confirmLabel}
          </Button>
        </>
      }
    >
      {text && (
        <input
          ref={input}
          value={value}
          placeholder={ask.placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && trimmed) {
              e.preventDefault()
              submit()
            }
          }}
          className="esq-field w-full"
        />
      )}
    </Dialog>
  )
}
