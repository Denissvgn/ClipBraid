import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  JournalEntry,
  filterJournal,
  getEvents,
  subscribeEvents,
} from "../services/journalService";
import { Icon } from "./Icon";
export const JournalViewer: React.FC<{
  entries: JournalEntry[];
  onClose: () => void;
}> = ({ entries, onClose }) => {
  const dialog = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState<"events" | "devlog">("events");
  const [query, setQuery] = useState("");
  const [tick, setTick] = useState(0);
  useEffect(() => subscribeEvents(() => setTick((value) => value + 1)), []);
  useEffect(() => {
    const el = dialog.current;
    el?.showModal();
    return () => el?.close();
  }, []);
  const events = useMemo(
    () =>
      getEvents()
        .reverse()
        .filter((event) =>
          `${event.kind} ${event.msg}`
            .toLowerCase()
            .includes(query.toLowerCase()),
        ),
    [tick, query],
  );
  const filtered = useMemo(
    () => filterJournal(entries, query),
    [entries, query],
  );
  return (
    <dialog
      ref={dialog}
      className="diagnostics-dialog"
      onCancel={onClose}
      aria-labelledby="diagnostics-title"
    >
      <div className="inspector-heading">
        <h2 id="diagnostics-title">Session details</h2>
        <button
          className="icon-button"
          onClick={onClose}
          aria-label="Close diagnostics"
        >
          <Icon name="close" />
        </button>
      </div>
      <p className="helper-text">
        Technical events from this session. These are not proof that a file was
        saved on your device.
      </p>
      <div className="segmented">
        <button
          onClick={() => setTab("events")}
          aria-pressed={tab === "events"}
        >
          System events
        </button>
        {entries.length > 0 && (
          <button
            onClick={() => setTab("devlog")}
            aria-pressed={tab === "devlog"}
          >
            Dev log
          </button>
        )}
      </div>
      <label className="diagnostics-filter" htmlFor="diagnostics-filter">
        Filter events
        <input
          id="diagnostics-filter"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <div className="diagnostics-list">
        {tab === "events" ? (
          events.length ? (
            <ol>
              {events.map((event, index) => (
                <li key={`${event.at}-${index}`} data-kind={event.kind}>
                  <time>{event.clock}</time>
                  <span>{event.msg}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p>No matching events in this session.</p>
          )
        ) : (
          filtered.map((entry, index) => (
            <details key={index}>
              <summary>{entry.title}</summary>
              <pre>{entry.body}</pre>
            </details>
          ))
        )}
      </div>
    </dialog>
  );
};
