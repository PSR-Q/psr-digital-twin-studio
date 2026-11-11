import { useEffect } from 'react';
import { LeftDock } from './components/layout/LeftDock';
import { RightInspector } from './components/layout/RightInspector';
import { StatusBar } from './components/layout/StatusBar';
import { TopToolbar } from './components/layout/TopToolbar';
import { PlcTagMatrixModal } from './components/modals/PlcTagMatrixModal';
import { ViewportCanvas } from './components/viewport/ViewportCanvas';
import { runtimeBusClient } from './engine/runtimeBusClient';
import { useEditorStore } from './store/editorStore';

export function App() {
  useEffect(() => {
    runtimeBusClient.init();
    runtimeBusClient.syncTagMap(useEditorStore.getState().scene.plcTagMap);
    return () => {
      runtimeBusClient.dispose();
    };
  }, []);

  // Industrial CAD Keyboard Shortcuts (W/E/R Gizmo, Space Run/Pause, Del Remove, Ctrl+D Dup, Ctrl+S Save, Esc Close Modal)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const store = useEditorStore.getState();

      if (e.key === 'Escape' && store.isTagMatrixModalOpen) {
        e.preventDefault();
        store.setTagMatrixModalOpen(false);
        return;
      }

      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void store.saveSceneInteractive();
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        if (store.selectedInstanceId) {
          store.duplicateInstance(store.selectedInstanceId);
        }
        return;
      }

      if (e.code === 'Space') {
        e.preventDefault();
        store.setRunState(store.runState === 'RUNNING' ? 'PAUSED' : 'RUNNING');
        return;
      }

      switch (e.key.toLowerCase()) {
        case 'w':
          store.setGizmoMode('translate');
          break;
        case 'e':
          store.setGizmoMode('rotate');
          break;
        case 'r':
          store.setGizmoMode('scale');
          break;
        case 'delete':
        case 'backspace':
          if (store.selectedInstanceId) {
            store.deleteInstance(store.selectedInstanceId);
          }
          break;
        case 'escape':
          if (store.isDrawingSplinePath) {
            store.setIsDrawingSplinePath(false);
          } else if (store.selectedSubMeshName) {
            store.selectSubMesh(null);
          } else {
            store.selectInstance(null);
          }
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className="vc-workbench">
      <h1 className="sr-only">
        VC Digital Twin Studio — Standalone 3D Industrial Virtual Commissioning Editor
      </h1>
      <TopToolbar />
      <main className="vc-main-area">
        <LeftDock />
        <ViewportCanvas />
        <RightInspector />
      </main>
      <StatusBar />
      <PlcTagMatrixModal />
    </div>
  );
}

export default App;
