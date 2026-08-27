/**
 * Composer Enter-key toggle: switches between "Enter sends" and "Shift+Enter
 * sends" (and the inverse newline behavior). This is a plain user choice,
 * shown next to the composer's send controls.
 */

import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

type EnterKeyToggleProps = {
    footerIconButtonClass: string;
    iconSizeClass: string;
    enterToSend: boolean;
    onToggle: () => void;
};

export const EnterKeyToggle = React.memo(function EnterKeyToggle(props: EnterKeyToggleProps) {
    const { footerIconButtonClass, iconSizeClass, enterToSend, onToggle } = props;
    const { t } = useI18n();

    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <button
                    type="button"
                    className={cn(
                        footerIconButtonClass,
                        'rounded-md',
                        enterToSend
                            ? 'text-primary'
                            : 'text-foreground hover:bg-[var(--interactive-hover)]/40'
                    )}
                    onMouseDown={(event) => {
                        event.preventDefault();
                    }}
                    onClick={onToggle}
                    aria-label={t(enterToSend
                        ? 'chat.chatInput.actions.enterToSend'
                        : 'chat.chatInput.actions.shiftEnterToSend')}
                    aria-pressed={enterToSend}
                >
                    <Icon name="corner-down-left" className={cn(iconSizeClass)} />
                </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={8}>
                <div className="flex flex-col gap-0.5 text-center">
                    <span>{t(enterToSend
                        ? 'chat.chatInput.actions.enterToSend'
                        : 'chat.chatInput.actions.shiftEnterToSend')}</span>
                </div>
            </TooltipContent>
        </Tooltip>
    );
});
