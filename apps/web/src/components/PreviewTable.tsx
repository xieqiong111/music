import type { Playlist, Track } from '@playlist-exporter/contracts';
import { zhCN } from '../i18n/zh-CN.js';

const PREVIEW_LIMIT = 20;

const availabilityLabel = (track: Track): string => {
  switch (track.availability) {
    case 'available': return zhCN.available;
    case 'unavailable': return zhCN.unavailable;
    case 'removed': return zhCN.removed;
    case 'unknown': return zhCN.unknown;
  }
};

export function PreviewTable({ playlist }: { readonly playlist: Playlist }) {
  const preview = playlist.tracks.slice(0, PREVIEW_LIMIT);
  return (
    <section aria-labelledby="preview-title">
      <div className="section-heading section-heading--split">
        <div>
          <p className="eyebrow">03</p>
          <h2 id="preview-title">{zhCN.previewTitle}</h2>
        </div>
        <div className="count-block">
          <strong>{zhCN.totalTracks(playlist.total)}</strong>
          <span>{zhCN.previewLimit(preview.length)}</span>
        </div>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>{zhCN.titleColumn}</th>
              <th>{zhCN.artistColumn}</th>
              <th>{zhCN.albumColumn}</th>
              <th>{zhCN.availabilityColumn}</th>
            </tr>
          </thead>
          <tbody>
            {preview.map(track => (
              <tr key={`${track.position}:${track.trackId ?? track.title}`}>
                <td>{track.position + 1}</td>
                <td>{track.title}</td>
                <td>{track.artists.join('、') || zhCN.unknownArtist}</td>
                <td>{track.album ?? zhCN.noAlbum}</td>
                <td>
                  <span className={track.availability === 'available' ? 'track-state' : 'track-state track-state--warning'}>
                    {availabilityLabel(track)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
