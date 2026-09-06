import { useEffect } from 'react'
import { useUI, type DevelopTool } from '../../state/ui'

export function toolPanelId(tool: DevelopTool): string | null {
  switch (tool) {
    case 'crop': return 'develop-crop'
    case 'mask': return 'develop-mask'
    case 'heal':
    case 'redeye': return 'develop-retouch'
    default: return null
  }
}

export function useToolInspector() {
  const tool = useUI((s) => s.developTool)
  const compact = useUI((s) => s.compact)

  useEffect(() => {
    if (!toolPanelId(tool)) return
    const ui = useUI.getState()
    // Reveal on activation, not on drawer dismissal: the photo must remain
    // reachable while the tool is active on a compact screen.
    if (compact) ui.setOverlayPanel('right')
    else if (!ui.rightPanelOpen) ui.toggleRightPanel()
  }, [tool, compact])
}
