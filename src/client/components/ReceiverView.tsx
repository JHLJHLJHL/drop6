import { useState } from 'react';
import { payloadSize, type Delivery } from '../../shared/transfer';
import { formatBytes, formatSpeed } from '../lib/format';
import {
  MEMORY_DOWNLOAD_NOTICE,
  MEMORY_LIMIT,
  describeJoinError,
  describeReceiverFailure,
} from '../lib/messages';
import type { ReceiverState } from '../lib/receiverSession';
import { receiveOptions } from '../lib/sink';
import { Button, FileCard, FileList, PrivacyNote, ProgressBar, Switch, TitleBlock, percentOf } from './ui';

interface ReceiverViewProps {
  state: ReceiverState;
  /**
   * User pressed a receive button. Must be called straight from the click (save dialog needs it).
   * `chooseLocation`: the user wants the save dialog instead of the browser's downloads folder.
   */
  onAccept(delivery: Delivery, chooseLocation: boolean): void;
  /** Decline (while reviewing) or cancel (while receiving) this transfer. */
  onCancel(): void;
  /** Go back to entering a code. */
  onRetry(): void;
}

const MEMORY_FILES_NOTICE = '파일 따로 받기는 파일마다 다운로드가 시작돼요. 브라우저가 여러 파일 다운로드를 물어보면 허용해주세요.';
const FOLDER_NOTICE = '파일 따로 받기는 파일을 담을 폴더를 골라요. 다운로드 폴더 자체는 고를 수 없는 브라우저가 있어서, 그 안에 새 폴더를 만들어 고르면 돼요.';
/** The browser's own download keeps the file in memory; bigger ones go through the save dialog. */
const BIG_FILE_NOTICE = `${MEMORY_LIMIT}를 넘는 파일은 저장 위치를 직접 골라야 해요.`;

export function ReceiverView({ state, onAccept, onCancel, onRetry }: ReceiverViewProps) {
  const [chooseLocation, setChooseLocation] = useState(false);
  const { meta, phase } = state;
  // Browsers that cannot write to disk only have the plain download, so there is nothing to choose.
  const locationSwitch = state.mode === 'file-system' && (
    <Switch checked={chooseLocation} onChange={setChooseLocation} label="위치 지정 다운로드" hint="(기본: 다운로드 폴더)" />
  );
  const detail = meta ? `${formatBytes(meta.size)} · ${meta.mime || '알 수 없는 형식'}` : '';
  const total = meta ? payloadSize(meta, state.delivery) : 0;
  /** The files one by one, while receiving or done. */
  const separate = meta?.files && state.delivery === 'files' ? meta.files : undefined;
  const received = separate ? (
    <FileCard name={`파일 ${separate.length}개`} detail={formatBytes(total)} />
  ) : (
    meta && <FileCard name={phase === 'done' ? (state.savedName ?? meta.name) : meta.name} detail={phase === 'done' ? formatBytes(meta.size) : detail} />
  );

  switch (phase) {
    case 'joining':
    case 'connecting':
      return (
        <section className="card stack">
          <TitleBlock title="잠시만 기다려주세요" />
          <p className="status" role="status">
            <span className="spinner spinner-dark" aria-hidden="true" />
            {phase === 'joining' ? '코드를 확인하고 있어요' : '보내는 사람과 연결하고 있어요'}
          </p>
          <Button variant="text" onClick={onRetry}>
            그만두기
          </Button>
        </section>
      );

    case 'review': {
      if (meta?.files) {
        const options = receiveOptions(meta, state.mode === 'file-system');
        const fitsInMemory = receiveOptions(meta, false);
        let note: string;
        if (!options.zip) {
          note = `이 브라우저는 파일을 메모리에 담아 받기 때문에 zip 전체(${formatBytes(meta.size)})는 받을 수 없어요. 파일을 따로 받으면 파일마다 ${MEMORY_LIMIT}까지 받을 수 있어요. ${MEMORY_FILES_NOTICE}`;
        } else if (state.mode === 'memory') {
          note = `${MEMORY_DOWNLOAD_NOTICE} ${MEMORY_FILES_NOTICE}`;
        } else if (chooseLocation) {
          note = FOLDER_NOTICE;
        } else {
          note = [fitsInMemory.files && MEMORY_FILES_NOTICE, !(fitsInMemory.zip && fitsInMemory.files) && BIG_FILE_NOTICE]
            .filter(Boolean)
            .join(' ');
        }
        return (
          <section className="card stack">
            <TitleBlock title="이 파일을 받을까요?" sub="보내는 사람이 보낸 파일 정보예요." />
            <FileList files={meta.files} />
            {note && <p className="note">{note}</p>}
            {locationSwitch}
            {options.zip && <Button onClick={() => onAccept('zip', chooseLocation)}>zip 하나로 받기</Button>}
            <Button variant={options.zip ? 'secondary' : 'primary'} onClick={() => onAccept('files', chooseLocation)}>
              파일 따로 받기
            </Button>
            <Button variant="text" onClick={onCancel}>
              받지 않기
            </Button>
            <PrivacyNote />
          </section>
        );
      }
      const note =
        state.mode === 'memory'
          ? MEMORY_DOWNLOAD_NOTICE
          : !chooseLocation && meta && !receiveOptions(meta, false).zip
            ? BIG_FILE_NOTICE
            : '';
      return (
        <section className="card stack">
          <TitleBlock title="이 파일을 받을까요?" sub="보내는 사람이 보낸 파일 정보예요." />
          {meta && <FileCard name={meta.name} detail={detail} />}
          {note && <p className="note">{note}</p>}
          {locationSwitch}
          <Button onClick={() => onAccept('zip', chooseLocation)}>파일 받기</Button>
          <Button variant="text" onClick={onCancel}>
            받지 않기
          </Button>
          <PrivacyNote />
        </section>
      );
    }

    case 'blocked':
      return (
        <section className="card stack">
          <TitleBlock
            title="이 파일은 받을 수 없어요"
            sub={`이 브라우저는 파일을 메모리에 담아 받기 때문에 ${MEMORY_LIMIT}까지만 받을 수 있어요${
              meta ? ` (이 파일은 ${formatBytes(meta.size)}예요)` : ''
            }. Windows의 Chrome이나 Edge로 열면 더 큰 파일도 받을 수 있어요.`}
          />
          <Button onClick={onRetry}>코드 다시 입력하기</Button>
        </section>
      );

    case 'receiving':
    case 'paused': {
      const percent = percentOf(state.savedBytes, total);
      const paused = phase === 'paused';
      return (
        <section className="card stack">
          {paused ? (
            <TitleBlock title="연결이 끊겼어요" sub="보내는 사람이 돌아오면 이어서 받아요" />
          ) : (
            <TitleBlock title="파일을 받는 중이에요" />
          )}
          {received}
          <div className="stack-tight">
            <ProgressBar percent={percent} label="받기 진행률" />
            <div className="progress-text">
              <span>{`${Math.floor(percent)}% · ${formatBytes(state.savedBytes)} / ${formatBytes(total)}`}</span>
              <span>{paused ? '' : formatSpeed(state.speed)}</span>
            </div>
          </div>
          <Button variant="secondary" onClick={onCancel}>
            받기 취소
          </Button>
        </section>
      );
    }

    case 'done':
      return (
        <section className="card stack">
          <TitleBlock
            title="다 받았어요"
            sub={
              state.savedName === undefined
                ? '다운로드 폴더를 확인해주세요.'
                : separate && state.savedName
                  ? `'${state.savedName}' 폴더에 저장했어요.`
                  : '선택한 위치에 저장했어요.'
            }
          />
          {received}
          <Button onClick={onRetry}>다른 파일 받기</Button>
        </section>
      );

    case 'canceled':
      return (
        <section className="card stack">
          <TitleBlock title="받기를 취소했어요" sub="다시 받으려면 보내는 사람에게 코드를 받아 입력해주세요." />
          <Button onClick={onRetry}>코드 다시 입력하기</Button>
        </section>
      );

    case 'failed': {
      const message = describeReceiverFailure(state.reason, state.hasTurn);
      return (
        <section className="card stack">
          <TitleBlock title={message.title} sub={message.body} />
          <Button onClick={onRetry}>코드 다시 입력하기</Button>
        </section>
      );
    }

    case 'error': {
      const message = describeJoinError(state.reason);
      return (
        <section className="card stack">
          <TitleBlock title={message.title} sub={message.body} />
          <Button onClick={onRetry}>코드 다시 입력하기</Button>
        </section>
      );
    }
  }
}
