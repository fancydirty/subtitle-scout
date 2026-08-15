// web/src/settings/RootPathInput.tsx：守备目录添加框——普通 text input。
// 用户知道自己磁盘上有什么目录；这里只负责把绝对路径交给后端校验并展示结果。
import { useState } from 'react'
import { Button } from '../components/ui/button.js'
import { Input } from '../components/ui/input.js'
import { api } from '../api/client.js'
import { useT } from '../i18n/useT.js'
import { localizeErrorValue } from '../lib/errorText.js'

interface Props {
  onAdded: (path: string) => void
}

export function RootPathInput({ onAdded }: Props) {
  const { t, lang } = useT()
  const [path, setPath] = useState('')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [addedMsg, setAddedMsg] = useState<string | null>(null)

  const submit = async () => {
    const target = path.trim()
    if (target === '') return
    setAdding(true)
    setError(null)
    setAddedMsg(null)
    try {
      await api.addRoot(target)
      setPath('')
      setAddedMsg(t('settings_roots_add_success'))
      onAdded(target)
    } catch (e) {
      setError(t('settings_roots_add_error_prefix') + localizeErrorValue(e, lang))
    } finally {
      setAdding(false)
    }
  }

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => { e.preventDefault(); void submit() }}
    >
      <div className="flex items-center gap-2">
        <Input
          aria-label={t('settings_roots_add_path_label')}
          value={path}
          onChange={(e) => {
            setPath(e.target.value)
            setError(null)
            setAddedMsg(null)
          }}
          placeholder={t('settings_roots_add_path_placeholder')}
          className="max-w-[420px]"
        />
        <Button type="submit" size="sm" disabled={adding || path.trim() === ''}>
          {t('settings_roots_add_button_label')}
        </Button>
      </div>
      {error ? <div className="settings-error-text" role="alert">{error}</div> : null}
      {addedMsg ? (
        <span className="text-[11px] leading-4 text-muted-foreground">{addedMsg}</span>
      ) : null}
    </form>
  )
}
