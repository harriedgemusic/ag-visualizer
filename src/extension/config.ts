import * as vscode from 'vscode'
import { setupFrom } from '../core/setup'
import type { Setup } from '../core/setup'
import type { UserOptions } from '../core/types'

export function isLightTheme(theme: vscode.ColorTheme): boolean {
  return (
    theme.kind === vscode.ColorThemeKind.Light ||
    theme.kind === vscode.ColorThemeKind.HighContrastLight
  )
}

export function readUserOptions(): UserOptions & { antigravityDataDir?: string } {
  const cfg = vscode.workspace.getConfiguration('agVisualizer')
  const rawDetail = cfg.get<string>('detailLevel', 'compact')
  const detailLevel = !vscode.workspace.isTrusted && rawDetail === 'debug' ? 'compact' : rawDetail
  return {
    language: cfg.get<string>('language', 'auto'),
    theme: cfg.get<string>('theme', 'auto'),
    background: cfg.get<string>('background', 'solid'),
    layout: cfg.get<string>('layout', 'you-top'),
    motion: cfg.get<string>('motion', 'full'),
    coreName: cfg.get<string>('coreName', 'AGY'),
    contextCost: cfg.get<boolean>('contextCost', true),
    contextWindowTokens: cfg.get<number>('contextWindowTokens', 0),
    textSize: cfg.get<string>('textSize', 'footnote'),
    detailLevel,
    subagentNames: cfg.get<boolean>('subagentNames', true),
    colors: cfg.get<Record<string, string>>('colors', {}),
    memoryPaths: cfg.get<string[]>('memoryPaths', []),
    memoryServers: cfg.get<string[]>('memoryServers', []),
    memoryCommands: cfg.get<string[]>('memoryCommands', []),
    serverStations: cfg.get<Record<string, string>>('serverStations', {}),
    commandStations: cfg.get<Record<string, string>>('commandStations', {}),
    antigravityDataDir: cfg.get<string>('antigravityDataDir', ''),
  }
}

export function buildSetup(opts = readUserOptions()): Setup {
  return setupFrom(opts, vscode.env.language)
}
