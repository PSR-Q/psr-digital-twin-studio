import {
  Copy,
  Cuboid,
  Download,
  Eye,
  EyeOff,
  FileDown,
  Layers,
  Link2,
  Lock,
  Plus,
  Trash2,
  Unlock,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  detectModelFormat,
  isUsdFormat,
} from '../../engine/glbAssetRegistry';
import type { ComponentCategory } from '../../shared/schemas';
import { useEditorStore } from '../../store/editorStore';

const CATEGORY_FILTERS: Array<{ key: 'ALL' | ComponentCategory; label: string }> = [
  { key: 'ALL', label: 'All' },
  { key: 'Conveyors', label: 'Conveyors' },
  { key: 'Actuators', label: 'Actuators' },
  { key: 'ProcessEquipment', label: 'Process' },
  { key: 'CustomGlb', label: 'Imported 3D' },
];

export function LeftDock() {
  const [activeCategory, setActiveCategory] = useState<'ALL' | ComponentCategory>('ALL');

  const library = useEditorStore((s) => s.scene.componentLibrary);
  const instances = useEditorStore((s) => s.scene.instances);
  const snapConnections = useEditorStore((s) => s.scene.snapConnections);
  const selectedInstanceId = useEditorStore((s) => s.selectedInstanceId);

  const spawnInstance = useEditorStore((s) => s.spawnInstance);
  const importGlbInteractive = useEditorStore((s) => s.importGlbInteractive);
  const selectInstance = useEditorStore((s) => s.selectInstance);
  const toggleInstanceVisibility = useEditorStore((s) => s.toggleInstanceVisibility);
  const toggleInstanceLock = useEditorStore((s) => s.toggleInstanceLock);
  const duplicateInstance = useEditorStore((s) => s.duplicateInstance);
  const deleteInstance = useEditorStore((s) => s.deleteInstance);

  const filteredCatalog = useMemo(() => {
    if (activeCategory === 'ALL') return library;
    return library.filter((c) => c.category === activeCategory);
  }, [library, activeCategory]);

  const snapCountByInstance = useMemo(() => {
    const counts = new Map<string, number>();
    for (const conn of snapConnections) {
      counts.set(conn.sourceInstanceId, (counts.get(conn.sourceInstanceId) ?? 0) + 1);
      counts.set(conn.targetInstanceId, (counts.get(conn.targetInstanceId) ?? 0) + 1);
    }
    return counts;
  }, [snapConnections]);

  return (
    <aside id="vc-left-dock" className="vc-left-dock">
      {/* Upper Pane: 3D .GLB & OpenUSD Component Catalog */}
      <section className="vc-dock-pane vc-catalog-pane">
        <div className="vc-pane-header">
          <div className="vc-pane-title">
            <Cuboid size={14} />
            <span>ASSET CATALOG (.GLB / .USD)</span>
          </div>
          <button
            id="btn-catalog-import-glb"
            type="button"
            className="vc-mini-action-btn"
            onClick={() => void importGlbInteractive()}
            title="Import .glb, .gltf, or OpenUSD (.usd, .usda, .usdc, .usdz) into Component Library"
          >
            <Download size={12} />
            <span>+ Import</span>
          </button>
        </div>

        {/* Category Filter Tabs */}
        <div className="vc-filter-strip">
          {CATEGORY_FILTERS.map((f) => (
            <button
              key={f.key}
              id={`filter-cat-${f.key}`}
              type="button"
              className={`vc-filter-pill ${activeCategory === f.key ? 'active' : ''}`}
              onClick={() => setActiveCategory(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>

        {/* Draggable Component Cards */}
        <div className="vc-catalog-list">
          {filteredCatalog.map((comp) => {
            const [sx, sy, sz] = comp.boundingBox.size;
            const fmt =
              comp.modelSource.format ??
              detectModelFormat(comp.modelSource.fileName || comp.modelSource.uri);
            const usdBadge = isUsdFormat(fmt);
            return (
              <div
                key={comp.id}
                id={`catalog-card-${comp.id}`}
                className="vc-catalog-card"
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('application/vc-component-id', comp.id);
                  e.dataTransfer.effectAllowed = 'copy';
                }}
              >
                <div className="vc-catalog-card-top">
                  <div>
                    <div className="vc-catalog-name">{comp.name}</div>
                    <div className="vc-catalog-meta">
                      <span
                        className={`vc-format-pill ${usdBadge ? 'usd' : 'glb'}`}
                      >
                        {fmt.toUpperCase()}
                      </span>{' '}
                      {sx.toFixed(2)}×{sy.toFixed(2)}×{sz.toFixed(2)}m ·{' '}
                      <span className="vc-port-count-highlight">
                        {comp.snapPorts.length} Ports
                      </span>
                    </div>
                  </div>

                  <div className="vc-catalog-actions">
                    {comp.modelSource.kind === 'builtin' && (
                      <a
                        id={`download-sample-${comp.id}`}
                        href={comp.modelSource.uri}
                        download={comp.modelSource.fileName}
                        className="vc-icon-btn"
                        title={`Download ${comp.modelSource.fileName} to test dragging external ${fmt.toUpperCase()} file`}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <FileDown size={13} />
                      </a>
                    )}
                    <button
                      id={`spawn-btn-${comp.id}`}
                      type="button"
                      className="vc-spawn-btn"
                      onClick={() => spawnInstance(comp.id)}
                      title="Place Machine in Scene (or drag card onto 3D floor)"
                    >
                      <Plus size={13} />
                      <span>Add</span>
                    </button>
                  </div>
                </div>
                <p className="vc-catalog-desc">{comp.description}</p>
              </div>
            );
          })}
        </div>
      </section>

      {/* Lower Pane: Scene Hierarchy Tree */}
      <section className="vc-dock-pane vc-hierarchy-pane">
        <div className="vc-pane-header">
          <div className="vc-pane-title">
            <Layers size={14} />
            <span>SCENE HIERARCHY ({instances.length})</span>
          </div>
          <span className="vc-snap-summary-chip" title="Active Magnetic Snap Connections">
            <Link2 size={11} />
            <span>{snapConnections.length} Links</span>
          </span>
        </div>

        <div className="vc-tree-list">
          {instances.length === 0 ? (
            <div className="vc-empty-hint">
              Scene is empty. Click <strong>Add</strong> on an asset above or drop any{' '}
              <code>.glb</code> file into the 3D viewport.
            </div>
          ) : (
            instances.map((inst) => {
              const isSelected = inst.id === selectedInstanceId;
              const linkCount = snapCountByInstance.get(inst.id) ?? 0;

              return (
                <div
                  key={inst.id}
                  id={`scene-tree-row-${inst.id}`}
                  className={`vc-tree-row ${isSelected ? 'selected' : ''}`}
                  onClick={() => selectInstance(inst.id)}
                >
                  <div className="vc-tree-row-main">
                    <span
                      className={`vc-tree-status-dot ${linkCount > 0 ? 'snapped' : ''}`}
                      title={
                        linkCount > 0
                          ? `${linkCount} active SnapPort connection(s)`
                          : 'Unconnected'
                      }
                    />
                    <span className="vc-tree-label">{inst.name}</span>
                    {linkCount > 0 && (
                      <span className="vc-tree-link-badge">{linkCount}</span>
                    )}
                  </div>

                  <div
                    className="vc-tree-row-actions"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      id={`vis-btn-${inst.id}`}
                      type="button"
                      className="vc-tree-icon-btn"
                      onClick={() => toggleInstanceVisibility(inst.id)}
                      title={inst.visible ? 'Hide Machine' : 'Show Machine'}
                    >
                      {inst.visible ? <Eye size={12} /> : <EyeOff size={12} />}
                    </button>
                    <button
                      id={`lock-btn-${inst.id}`}
                      type="button"
                      className="vc-tree-icon-btn"
                      onClick={() => toggleInstanceLock(inst.id)}
                      title={inst.locked ? 'Unlock Transform' : 'Lock Transform'}
                    >
                      {inst.locked ? <Lock size={12} /> : <Unlock size={12} />}
                    </button>
                    <button
                      id={`dup-btn-${inst.id}`}
                      type="button"
                      className="vc-tree-icon-btn"
                      onClick={() => duplicateInstance(inst.id)}
                      title="Duplicate Instance (Ctrl+D)"
                    >
                      <Copy size={12} />
                    </button>
                    <button
                      id={`del-btn-${inst.id}`}
                      type="button"
                      className="vc-tree-icon-btn vc-danger-hover"
                      onClick={() => deleteInstance(inst.id)}
                      title="Delete Instance (Del)"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </section>
    </aside>
  );
}
