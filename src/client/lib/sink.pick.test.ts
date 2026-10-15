// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pickFileSystemSink } from './sink';

type PickerWindow = { showSaveFilePicker?: unknown };

afterEach(() => {
  delete (window as PickerWindow).showSaveFilePicker;
});

describe('pickFileSystemSink', () => {
  it('opens the save dialog on the downloads folder with a safe suggested name', async () => {
    const writable = { write: async () => {}, close: async () => {}, abort: async () => {} };
    const picker = vi.fn().mockResolvedValue({ name: 'report.pdf', createWritable: async () => writable });
    (window as PickerWindow).showSaveFilePicker = picker;

    const picked = await pickFileSystemSink('../report.pdf');

    expect(picker).toHaveBeenCalledWith({ suggestedName: '.._report.pdf', startIn: 'downloads' });
    expect(picked?.savedName).toBe('report.pdf');
  });

  it('returns undefined when the user dismisses the dialog', async () => {
    (window as PickerWindow).showSaveFilePicker = vi.fn().mockRejectedValue(new DOMException('dismissed', 'AbortError'));
    await expect(pickFileSystemSink('a.txt')).resolves.toBeUndefined();
  });

  it('rethrows other failures so the session can report a storage problem', async () => {
    (window as PickerWindow).showSaveFilePicker = vi.fn().mockRejectedValue(new DOMException('blocked', 'SecurityError'));
    await expect(pickFileSystemSink('a.txt')).rejects.toThrow('blocked');
  });
});
