import { useState } from "react";
import { api } from "../api/client";
import { useInventory, useMovements } from "../api/queries";
import { Empty, ErrorState, Loading, PageShell, fmtMoney, fmtTime, useAct } from "../components/ui";

export default function InventoryPage() {
  const { data, isLoading, error, refetch } = useInventory();
  const { data: mv } = useMovements();
  const { run, busy } = useAct();
  const [sku, setSku] = useState("BRG-001");
  const [qty, setQty] = useState(2);
  const receive = () => run(() => api.post("/api/inventory/receive", { sku, quantity: qty }), `Received ${qty} × ${sku}`);
  return (
    <PageShell
      title="Inventory"
      subtitle="Stock is a transactional ledger: quantity on hand is the sum of movements. Parts are reserved when a technician is assigned and consumed when work is completed; concurrent completions cannot make stock negative."
    >
      {isLoading && <Loading />}
      {error && <ErrorState error={error} retry={() => refetch()} />}
      {data && (
        <>
          {data.low_stock.length > 0 && (
            <div className="mb-4 rounded-md border border-watch/50 bg-watch/10 p-3 text-sm text-watch" role="status" data-testid="low-stock">
              Low stock: {data.low_stock.join(", ")} — at or below the reorder level.
            </div>
          )}
          <div className="card scroll-thin overflow-x-auto">
            <table className="w-full text-sm" data-testid="stock-table">
              <thead>
                <tr>
                  <th className="th">SKU</th><th className="th">Item</th><th className="th">On hand</th><th className="th">Reserved</th>
                  <th className="th">Available</th><th className="th">Reorder at</th><th className="th">Unit cost</th><th className="th">Location</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((i) => (
                  <tr key={i.sku} className="tr" data-testid={`stock-${i.sku}`}>
                    <td className="td font-medium">{i.sku}</td>
                    <td className="td">{i.name}</td>
                    <td className="td tabular-nums" data-testid={`onhand-${i.sku}`}>{i.on_hand}</td>
                    <td className="td tabular-nums">{i.reserved}</td>
                    <td className="td tabular-nums">{i.available}</td>
                    <td className="td tabular-nums">{i.reorder_level}</td>
                    <td className="td tabular-nums">{fmtMoney(i.unit_cost)}</td>
                    <td className="td">{i.location}{i.low_stock && <span className="badge badge-watch ml-2">low</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            <section className="card p-4">
              <div className="h-section mb-2">Receive stock</div>
              <p className="mb-2 text-xs text-muted">Supervisor action. Receiving parts also resumes work orders that are on hold awaiting parts.</p>
              <select className="input mb-2" value={sku} onChange={(e) => setSku(e.target.value)} aria-label="SKU">
                {data.items.map((i) => (<option key={i.sku} value={i.sku}>{i.sku} — {i.name}</option>))}
              </select>
              <input className="input mb-2" type="number" min={1} value={qty} onChange={(e) => setQty(Number(e.target.value))} aria-label="Quantity" />
              <button className="btn btn-primary w-full" disabled={busy} onClick={receive} data-testid="receive-stock">Receive stock</button>
            </section>
            <section className="card p-4 lg:col-span-2">
              <div className="h-section mb-2">Reservations</div>
              {data.reservations.length === 0 ? (
                <Empty title="No reservations" hint="Parts are reserved when a technician is assigned." />
              ) : (
                <table className="w-full text-xs">
                  <thead><tr><th className="th">Work order</th><th className="th">SKU</th><th className="th">Qty</th><th className="th">Status</th><th className="th">Created</th></tr></thead>
                  <tbody>
                    {data.reservations.map((r) => (
                      <tr key={r.id} className="tr"><td className="td">{r.work_order}</td><td className="td">{r.sku}</td><td className="td">{r.quantity}</td><td className="td">{r.status}</td><td className="td">{fmtTime(r.created_at)}</td></tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </div>
          <section className="card scroll-thin mt-4 overflow-x-auto">
            <div className="h-section p-4 pb-0">Movement ledger (source of truth)</div>
            <table className="w-full text-xs" data-testid="ledger">
              <thead>
                <tr><th className="th">When (sim)</th><th className="th">SKU</th><th className="th">Type</th><th className="th">Qty</th><th className="th">Balance</th><th className="th">Work order</th><th className="th">Note</th></tr>
              </thead>
              <tbody>
                {(mv?.items ?? []).map((m) => (
                  <tr key={m.id} className="tr">
                    <td className="td tabular-nums">{fmtTime(m.occurred_at)}</td><td className="td">{m.sku}</td><td className="td">{m.movement_type}</td>
                    <td className={`td tabular-nums ${m.quantity < 0 ? "text-bad" : "text-ok"}`}>{m.quantity > 0 ? `+${m.quantity}` : m.quantity}</td>
                    <td className="td tabular-nums">{m.balance_after}</td><td className="td">{m.work_order ?? "—"}</td><td className="td text-muted">{m.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
    </PageShell>
  );
}
