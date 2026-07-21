import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import type { ApiClient } from "../api/client.js";
import type {
  FinishedDemoItem,
  FinishedGameItem,
  FinishedStakedItem,
  GamesPage,
  Meta,
  OngoingGameItem,
} from "../api/schemas.js";
import { Board } from "../board/Board.jsx";
import { AppShell } from "../components/AppShell.jsx";
import { outcomeFor, outcomeGlyph } from "../games/outcome.js";
import { QuickView } from "../games/QuickView.jsx";
import { explorerTxUrl } from "../lib/explorer.js";
import { formatLocalTime, formatMicroUsdc } from "../lib/format.js";

function Pager(props: {
  readonly page: number;
  readonly pageCount: number;
  readonly onPage: (page: number) => void;
}) {
  if (props.pageCount <= 1) return null;
  return (
    <p className="pager">
      <button
        type="button"
        className="btn mini"
        disabled={props.page <= 1}
        onClick={() => props.onPage(props.page - 1)}
      >
        ◂ prev
      </button>{" "}
      page {props.page}/{props.pageCount}{" "}
      <button
        type="button"
        className="btn mini"
        disabled={props.page >= props.pageCount}
        onClick={() => props.onPage(props.page + 1)}
      >
        next ▸
      </button>
    </p>
  );
}

/** F-W5 archive: active rows + finished grid, one route. Grid cards are
 * static — thumbnails render from `finalFen`, replays load only in the
 * quick-view. Active rows carry no game names by design (I7). */
export function Archive(props: {
  readonly client: ApiClient;
  readonly meta: Meta;
}) {
  const { client } = props;
  // The sharer's refCode rides every share URL (F-W12); profile is
  // refetched on demand (§5.1).
  const [refCode, setRefCode] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    client
      .getProfile()
      .then((profile) => {
        if (!cancelled) setRefCode(profile.refCode ?? null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client]);
  const [searchParams, setSearchParams] = useSearchParams();
  const pageParam = Number(searchParams.get("page") ?? "1");
  const finishedPage =
    Number.isInteger(pageParam) && pageParam >= 1 ? pageParam : 1;
  const [activePage, setActivePage] = useState(1);
  const [active, setActive] = useState<GamesPage<OngoingGameItem> | null>(null);
  const [finished, setFinished] = useState<GamesPage<FinishedGameItem> | null>(
    null,
  );
  const [open, setOpen] = useState<
    FinishedStakedItem | FinishedDemoItem | null
  >(null);

  useEffect(() => {
    let cancelled = false;
    client
      .getOngoingGames(activePage)
      .then((page) => {
        if (!cancelled) setActive(page);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client, activePage]);

  useEffect(() => {
    let cancelled = false;
    client
      .getFinishedGames(finishedPage)
      .then((page) => {
        if (!cancelled) setFinished(page);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client, finishedPage]);

  return (
    <AppShell>
      <div className="archive">
        <section aria-label="active moves">
          <h2>ACTIVE</h2>
          <p className="faintt">
            two of these could be the same game and you'd never know (that's the
            point).
          </p>
          {active === null ? (
            <p className="console">&gt; loading…</p>
          ) : active.items.length === 0 ? (
            <div className="empty">
              <span className="vt">[ NO SIGNAL ]</span>
              no moves in flight.
            </div>
          ) : (
            <ul className="activelist">
              {active.items.map((item, index) => (
                <li
                  // biome-ignore lint/suspicious/noArrayIndexKey: rows carry no id on purpose (I7) and the list only changes by refetch
                  key={index}
                  className="activerow"
                  data-testid="active-row"
                >
                  <span className="mv">{item.yourMove.san}</span>
                  <span>{item.yourSide}</span>
                  {item.demo ? (
                    <span className="chip">DEMO</span>
                  ) : (
                    <span>{formatMicroUsdc(item.stakeMicroUsdc)}</span>
                  )}
                  <span className="dim">
                    claimed {formatLocalTime(item.claimedAt)}
                  </span>
                  {item.payTxid !== null ? (
                    <a
                      href={explorerTxUrl(
                        props.meta.network.explorerBaseUrl,
                        item.payTxid,
                      )}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      tx ↗
                    </a>
                  ) : null}
                  <span className="dim">pending…</span>
                </li>
              ))}
            </ul>
          )}
          {active !== null ? (
            <Pager
              page={active.page}
              pageCount={active.pageCount}
              onPage={setActivePage}
            />
          ) : null}
        </section>

        <section aria-label="finished games">
          <h2>FINISHED</h2>
          {finished === null ? (
            <p className="console">&gt; loading…</p>
          ) : finished.items.length === 0 ? (
            <div className="empty">
              <span className="vt">[ NO SIGNAL ]</span>
              your first board is one PLAY away.
            </div>
          ) : (
            <div className="finishedgrid">
              {finished.items.map((item, index) => {
                const outcome = outcomeFor(item.result, item.yourSide);
                // `demo` is the discriminator — never field presence (I7).
                if (item.demo || !("gameId" in item)) {
                  return (
                    <button
                      // biome-ignore lint/suspicious/noArrayIndexKey: demo cards carry no id on purpose (I7)
                      key={index}
                      type="button"
                      className="fincard demo"
                      data-testid="finished-demo-card"
                      onClick={() => setOpen(item)}
                    >
                      <span className="vt">— demo —</span>
                      <span>{outcomeGlyph(outcome)}</span>
                      <span className="chip">DEMO</span>
                    </button>
                  );
                }
                return (
                  <button
                    key={item.gameId}
                    type="button"
                    className="fincard"
                    data-testid="finished-card"
                    onClick={() => setOpen(item)}
                  >
                    <span className="thumb" aria-hidden="true">
                      <Board fen={item.finalFen} />
                    </span>
                    <span className="vt">{item.gameName}</span>
                    <span>{outcomeGlyph(outcome)}</span>
                    <span>{formatMicroUsdc(item.payoutMicroUsdc)}</span>
                  </button>
                );
              })}
            </div>
          )}
          {finished !== null ? (
            <Pager
              page={finished.page}
              pageCount={finished.pageCount}
              onPage={(page) => setSearchParams({ page: String(page) })}
            />
          ) : null}
        </section>
      </div>
      {open !== null ? (
        <QuickView
          client={client}
          item={open}
          meta={props.meta}
          refCode={refCode}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </AppShell>
  );
}
