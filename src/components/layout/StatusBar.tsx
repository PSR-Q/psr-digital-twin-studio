import { Terminal } from 'lucide-react';
import { useMemo } from 'react';
import { useEditorStore } from '../../store/editorStore';

export function StatusBar() {
  const statusMessage = useEditorStore((s) => s.statusMessage);
  const selectedInstanceId = useEditorStore((s) => s.selectedInstanceId);
  const instances = useEditorStore((s) => s.scene.instances);
  const snapConnections = useEditorStore((s) => s.scene.snapConnections);

  const selectedCoords = useMemo(() => {
    const inst = instances.find((i) => i.id === selectedInstanceId);
    if (!inst) return null;
    return inst.transform.position.map((v) => v.toFixed(3)).join(', ');
  }, [instances, selectedInstanceId]);

  return (
    <footer id="vc-status-bar" className="vc-status-bar">
      <div className="vc-status-left">
        <Terminal size={12} className="vc-status-icon" />
        <span className="vc-status-text">{statusMessage}</span>
      </div>

      <div className="vc-status-right">
        {selectedCoords && (
          <span className="vc-status-metric vc-mono-text">
            XYZ: [{selectedCoords}] m
          </span>
        )}
        <span className="vc-status-metric vc-mono-text">
          Snapped Ports: {snapConnections.length}
        </span>
        <span className="vc-status-shortcuts">
          W Move · E Rotate · R Scale · Ctrl+D Dup · Del Remove · Ctrl+S Save
        </span>
      </div>
    </footer>
  );
}
