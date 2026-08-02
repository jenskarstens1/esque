/**
 * File System Access API bits that TypeScript's DOM lib still doesn't ship.
 * Chromium implements all of these; the declarations just make them visible.
 */

interface FileSystemHandlePermissionDescriptor {
  mode?: 'read' | 'readwrite'
}

interface FileSystemHandle {
  queryPermission?(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>
  requestPermission?(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>
}

interface DirectoryPickerOptions {
  id?: string
  mode?: 'read' | 'readwrite'
  startIn?:
    | FileSystemHandle
    | 'desktop'
    | 'documents'
    | 'downloads'
    | 'pictures'
    | 'music'
    | 'videos'
}

interface FilePickerType {
  description?: string
  accept: Record<string, string[]>
}

interface SaveFilePickerOptions {
  id?: string
  suggestedName?: string
  startIn?: FileSystemHandle | 'desktop' | 'documents' | 'downloads' | 'pictures'
  types?: FilePickerType[]
}

interface Window {
  showDirectoryPicker(options?: DirectoryPickerOptions): Promise<FileSystemDirectoryHandle>
  showSaveFilePicker(options?: SaveFilePickerOptions): Promise<FileSystemFileHandle>
  showOpenFilePicker(options?: {
    id?: string
    multiple?: boolean
    types?: FilePickerType[]
  }): Promise<FileSystemFileHandle[]>
}

interface DataTransferItem {
  getAsFileSystemHandle?(): Promise<FileSystemHandle | null>
}

